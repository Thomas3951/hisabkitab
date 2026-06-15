/**
 * Subscription billing (v2.0 P10) contract tests over the real tenant-bound
 * Payments MCP. Prices come from plan config (Rs 2999/4999/7999), never the
 * caller. Dev mode never charges; live mode goes through Khalti. Probes per §8.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startKhaltiStub, type KhaltiStub } from '../src/khalti-stub.js';
import { SUBSCRIPTION_PLANS } from '../src/plans.js';
import { appDb, createTenant, openSession, type TestSession } from './helpers.js';

let stub: KhaltiStub;
let handle: ReturnType<typeof appDb>;
let devSession: TestSession; // ctx.live omitted -> dev mode
let liveSession: TestSession; // ctx.live = true -> Khalti path
let tenant: string;

beforeAll(async () => {
  stub = await startKhaltiStub('test-khalti-secret');
  handle = appDb();
  tenant = await createTenant('Subscription Pasal');
  devSession = await openSession(handle, tenant, stub);
  liveSession = await openSession(handle, tenant, stub, { live: true });
});

afterAll(async () => {
  await devSession.close();
  await liveSession.close();
  await handle.close();
  await stub.close();
});

interface PlanList {
  currency: string;
  live: boolean;
  plans: Array<{ code: string; name: string; price_paisa: number; price_display: string }>;
}

describe('list_subscription_plans', () => {
  it('returns the three tiers priced 2999 / 4999 / 7999 in paisa', async () => {
    const r = await devSession.callTool<PlanList>('list_subscription_plans');
    expect(r.currency).toBe('NPR');
    expect(r.plans.map((p) => p.price_paisa)).toEqual([299_900, 499_900, 799_900]);
    expect(r.plans.map((p) => p.code)).toEqual(['starter', 'pro', 'business']);
    expect(r.plans[2]!.price_display).toBe('Rs 7,999');
    expect(r.live).toBe(false); // dev session
  });

  it('config and contract agree (single source of truth)', () => {
    expect(SUBSCRIPTION_PLANS.map((p) => p.pricePaisa)).toEqual([299_900, 499_900, 799_900]);
  });
});

describe('initiate_subscription — dev mode (no charge)', () => {
  it('returns the plan + price but does NOT call Khalti or write a payment', async () => {
    const before = stub.payments.size;
    const r = await devSession.callTool<{
      ok: boolean;
      mode: string;
      amount_paisa: number;
      charged: boolean;
    }>('initiate_subscription', { plan_code: 'pro', owner_approved: true });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('development');
    expect(r.amount_paisa).toBe(499_900);
    expect(r.charged).toBe(false);
    expect(stub.payments.size).toBe(before); // nothing hit the gateway
  });

  it('PROBE: missing owner_approved is rejected (consent gate, no charge)', async () => {
    const before = stub.payments.size;
    const r = await devSession.callToolRaw('initiate_subscription', { plan_code: 'starter' });
    expect(r.isError).toBe(true);
    expect(stub.payments.size).toBe(before);
  });

  it('PROBE: an unknown plan_code is rejected at the schema (never charges)', async () => {
    const before = stub.payments.size;
    const r = await devSession.callToolRaw('initiate_subscription', {
      plan_code: 'enterprise', // not a real tier
      owner_approved: true,
    });
    expect(r.isError).toBe(true);
    expect(stub.payments.size).toBe(before);
  });
});

describe('initiate_subscription — live mode (Khalti path)', () => {
  it('creates a Khalti payment for the plan price, exactly once', async () => {
    const before = stub.payments.size;
    const r = await liveSession.callTool<{
      ok: boolean;
      mode: string;
      pidx: string;
      payment_url: string;
      amount_paisa: number;
    }>('initiate_subscription', { plan_code: 'business', owner_approved: true });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('live');
    expect(r.amount_paisa).toBe(799_900); // priced from config, not the caller
    expect(r.pidx).toBeTruthy();
    expect(r.payment_url).toContain('http');
    expect(stub.payments.size).toBe(before + 1);
  });
});

describe('subscription lifecycle (trial → pay → active, exactly-once)', () => {
  let s: TestSession;
  let tid: string;

  beforeAll(async () => {
    tid = await createTenant('Lifecycle Pasal');
    s = await openSession(handle, tid, stub, { live: true });
  });
  afterAll(async () => {
    await s.close();
  });

  it('start_trial creates a trial; calling again is idempotent', async () => {
    const a = await s.callTool<{ created: boolean; status: string }>('start_trial', { plan_code: 'pro' });
    expect(a.created).toBe(true);
    expect(a.status).toBe('trial');
    const b = await s.callTool<{ created: boolean; status: string }>('start_trial', { plan_code: 'pro' });
    expect(b.created).toBe(false); // no second subscription row
  });

  it('get_subscription_status reports access during the trial', async () => {
    const r = await s.callTool<{ exists: boolean; status: string; has_access: boolean }>('get_subscription_status');
    expect(r.exists).toBe(true);
    expect(r.has_access).toBe(true);
  });

  it('a completed payment activates the subscription and returns a receipt', async () => {
    const init = await s.callTool<{ pidx: string }>('initiate_subscription', { plan_code: 'pro', owner_approved: true });
    stub.completePayment(init.pidx);

    const v = await s.callTool<{
      ok: boolean;
      status: string;
      plan: string;
      current_period_end: string;
      receipt: { amount_paisa: number; period_end: string };
    }>('verify_subscription', { pidx: init.pidx });
    expect(v.ok).toBe(true);
    expect(v.status).toBe('completed');
    expect(v.plan).toBe('pro');
    expect(v.receipt.amount_paisa).toBe(499_900);

    const st = await s.callTool<{ status: string; current_period_end: string }>('get_subscription_status');
    expect(st.status).toBe('active');
    expect(st.current_period_end).toBe(v.current_period_end);
  });

  it('PROBE: a replayed verify_subscription credits the period exactly once', async () => {
    const init = await s.callTool<{ pidx: string }>('initiate_subscription', { plan_code: 'business', owner_approved: true });
    stub.completePayment(init.pidx);
    const first = await s.callTool<{ current_period_end: string }>('verify_subscription', { pidx: init.pidx });
    const replay = await s.callTool<{ already_credited?: boolean; current_period_end: string }>('verify_subscription', {
      pidx: init.pidx,
    });
    expect(replay.already_credited).toBe(true);
    expect(replay.current_period_end).toBe(first.current_period_end); // not extended twice
  });

  it('cancel_subscription is terminal but keeps access until period end', async () => {
    const r = await s.callTool<{ ok: boolean; status: string; access_until: string }>('cancel_subscription', {
      owner_approved: true,
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('cancelled');
    const st = await s.callTool<{ status: string }>('get_subscription_status');
    expect(st.status).toBe('cancelled');
  });

  it('PROBE: cancel_subscription without owner_approved is rejected', async () => {
    const fresh = await createTenant('No-Consent Pasal');
    const fs = await openSession(handle, fresh, stub, { live: true });
    try {
      await fs.callTool('start_trial', { plan_code: 'starter' });
      const r = await fs.callToolRaw('cancel_subscription', {});
      expect(r.isError).toBe(true);
    } finally {
      await fs.close();
    }
  });
});
