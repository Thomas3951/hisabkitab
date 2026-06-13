/**
 * Phase 5 contract tests — real Postgres (RLS-constrained role), real MCP
 * client, real KhaltiClient code path against the local stub gateway.
 * Money-critical invariants per CLAUDE.md §3/§8, each with adversarial probes:
 * consent gate, lookup-as-truth, amount reconciliation, exactly-once sales.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startKhaltiStub, type KhaltiStub } from '../src/khalti-stub.js';
import { KhaltiClient, KhaltiError } from '../src/khalti.js';
import { appDb, createTenant, openSession, STUB_SECRET, type TestSession } from './helpers.js';
import { ADMIN_URL } from './urls.js';

let stub: KhaltiStub;
let handle: ReturnType<typeof appDb>;
let tenantA: string;
let tenantB: string;
let sessionA: TestSession;
let sessionB: TestSession;
const adminSql = postgres(ADMIN_URL, { max: 1 });

beforeAll(async () => {
  stub = await startKhaltiStub(STUB_SECRET);
  handle = appDb();
  tenantA = await createTenant('Payments Pasal A');
  tenantB = await createTenant('Payments Pasal B');
  sessionA = await openSession(handle, tenantA, stub);
  sessionB = await openSession(handle, tenantB, stub);
});

afterAll(async () => {
  await sessionA.close();
  await sessionB.close();
  await handle.close();
  await stub.close();
  await adminSql.end({ timeout: 5 });
});

const salesCountFor = async (gatewayRef: string): Promise<number> => {
  const rows = await adminSql`SELECT count(*)::int AS n FROM sales WHERE gateway_ref = ${gatewayRef}`;
  return rows[0]?.['n'] as number;
};

describe('consent gate (no money action without the owner\'s explicit ✅)', () => {
  it('PROBE: initiate_payment without owner_approved never reaches Khalti', async () => {
    const r = await sessionA.callToolRaw('initiate_payment', { amount_paisa: 904000, purpose: 'momo set' });
    expect(r.isError).toBe(true);
    expect(stub.payments.size).toBe(0);
  });

  it('PROBE: owner_approved=false is rejected too (literal true only)', async () => {
    const r = await sessionA.callToolRaw('initiate_payment', {
      amount_paisa: 904000,
      purpose: 'momo set',
      owner_approved: false,
    });
    expect(r.isError).toBe(true);
    expect(stub.payments.size).toBe(0);
  });

  it('PROBE: refund_payment without owner_approved is rejected', async () => {
    const r = await sessionA.callToolRaw('refund_payment', { pidx: 'whatever' });
    expect(r.isError).toBe(true);
  });
});

describe('initiate → verify lifecycle (lookup is the only truth)', () => {
  let pidx: string;

  it('initiates with consent: payment_url returned, row is `initiated`, audit logged', async () => {
    const r = await sessionA.callTool<{ ok: boolean; pidx: string; payment_url: string }>('initiate_payment', {
      amount_paisa: 904000,
      purpose: 'momo set x4',
      owner_approved: true,
    });
    expect(r.ok).toBe(true);
    expect(r.payment_url).toContain(r.pidx);
    pidx = r.pidx;
    const rows = await adminSql`SELECT status, amount_paisa FROM payments WHERE pidx = ${pidx}`;
    expect(rows[0]?.['status']).toBe('initiated');
    expect(Number(rows[0]?.['amount_paisa'])).toBe(904000);
    const audit = await adminSql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'payment.initiated'`;
    expect(audit[0]?.['n']).toBeGreaterThan(0);
  });

  it('PROBE: verify before the payer pays records NOTHING (gateway says Initiated)', async () => {
    const r = await sessionA.callTool<{ ok: boolean; status: string }>('verify_payment', { pidx });
    expect(r.ok).toBe(false);
    expect(await salesCountFor(pidx)).toBe(0);
  });

  it('completes after payment: ONE confirmed gateway sale with the exact VAT-inclusive split', async () => {
    stub.completePayment(pidx);
    const r = await sessionA.callTool<{
      ok: boolean;
      status: string;
      sale_id: string;
      amount_excl_vat_paisa: number;
      vat_paisa: number;
    }>('verify_payment', { pidx });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('completed');
    expect(r.amount_excl_vat_paisa).toBe(800000);
    expect(r.vat_paisa).toBe(104000);
    const sale = await adminSql`SELECT status, source, payment_method FROM sales WHERE id = ${r.sale_id}`;
    expect(sale[0]).toMatchObject({ status: 'confirmed', source: 'gateway', payment_method: 'khalti' });
  });

  it('PROBE: verifying AGAIN does not create a second sale (exactly-once)', async () => {
    const r = await sessionA.callTool<{ ok: boolean; already_recorded?: boolean }>('verify_payment', { pidx });
    expect(r.ok).toBe(true);
    expect(r.already_recorded).toBe(true);
    expect(await salesCountFor(pidx)).toBe(1);
  });

  it('PROBE: tenant B cannot see or settle tenant A\'s payment (RLS)', async () => {
    const r = await sessionB.callTool<{ ok: boolean; reason?: string }>('verify_payment', { pidx });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no such payment/);
  });
});

describe('adversarial gateway states', () => {
  it('PROBE: lookup amount ≠ initiated amount → amount_mismatch, NEVER completed', async () => {
    const init = await sessionA.callTool<{ pidx: string }>('initiate_payment', {
      amount_paisa: 500000,
      purpose: 'tampered txn',
      owner_approved: true,
    });
    stub.completePayment(init.pidx);
    stub.tamperLookupAmount(init.pidx, 400000); // gateway lies about the amount
    const r = await sessionA.callTool<{ ok: boolean; status: string; reason: string }>('verify_payment', {
      pidx: init.pidx,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('amount_mismatch');
    expect(await salesCountFor(init.pidx)).toBe(0);
    const row = await adminSql`SELECT status FROM payments WHERE pidx = ${init.pidx}`;
    expect(row[0]?.['status']).toBe('amount_mismatch');
  });

  it('a canceled payment is marked canceled and records nothing', async () => {
    const init = await sessionA.callTool<{ pidx: string }>('initiate_payment', {
      amount_paisa: 100000,
      purpose: 'canceled txn',
      owner_approved: true,
    });
    stub.cancelPayment(init.pidx);
    const r = await sessionA.callTool<{ ok: boolean; status: string }>('verify_payment', { pidx: init.pidx });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('canceled');
    expect(await salesCountFor(init.pidx)).toBe(0);
  });
});

describe('refunds', () => {
  it('refunds a completed payment after explicit consent', async () => {
    const init = await sessionA.callTool<{ pidx: string }>('initiate_payment', {
      amount_paisa: 226000,
      purpose: 'refund me',
      owner_approved: true,
    });
    stub.completePayment(init.pidx);
    await sessionA.callTool('verify_payment', { pidx: init.pidx });
    const r = await sessionA.callTool<{ ok: boolean; status: string }>('refund_payment', {
      pidx: init.pidx,
      owner_approved: true,
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('refunded');
  });

  it('PROBE: refunding a non-completed payment is refused', async () => {
    const init = await sessionA.callTool<{ pidx: string }>('initiate_payment', {
      amount_paisa: 100000,
      purpose: 'not paid yet',
      owner_approved: true,
    });
    const r = await sessionA.callTool<{ ok: boolean; reason: string }>('refund_payment', {
      pidx: init.pidx,
      owner_approved: true,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/only completed/);
  });
});

describe('roadmap stubs + listing', () => {
  it('eSewa and Fonepay return a friendly coming-soon the agent can relay', async () => {
    const e = await sessionA.callTool<{ status: string; message: string }>('esewa_initiate_payment');
    const f = await sessionA.callTool<{ status: string; message: string }>('fonepay_initiate_payment');
    expect(e.status).toBe('coming_soon');
    expect(e.message).toMatch(/eSewa is coming soon/);
    expect(f.message).toMatch(/Fonepay is coming soon/);
  });

  it('list_collected_payments is tenant-scoped and filterable', async () => {
    const all = await sessionA.callTool<{ count: number }>('list_collected_payments');
    expect(all.count).toBeGreaterThanOrEqual(4);
    const other = await sessionB.callTool<{ count: number }>('list_collected_payments');
    expect(other.count).toBe(0); // tenant B never initiated anything
    const mismatched = await sessionA.callTool<{ count: number; items: Array<{ status: string }> }>(
      'list_collected_payments',
      { status: 'amount_mismatch' },
    );
    expect(mismatched.items.every((i) => i.status === 'amount_mismatch')).toBe(true);
  });
});

describe('KhaltiClient auth behavior (matches live dev.khalti.com)', () => {
  it('PROBE: a wrong secret key is rejected with Khalti\'s 401 "Invalid token."', async () => {
    const bad = new KhaltiClient({ secretKey: 'wrong-secret', origin: stub.origin });
    await expect(
      bad.initiatePayment({
        amountPaisa: 1000n,
        purchaseOrderId: 'x',
        purchaseOrderName: 'x',
        returnUrl: 'http://example.com/',
        websiteUrl: 'http://example.com/',
      }),
    ).rejects.toThrowError(KhaltiError);
  });
});
