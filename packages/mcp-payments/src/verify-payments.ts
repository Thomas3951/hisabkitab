/**
 * Runtime verification (CLAUDE.md §8) of the REAL Payments HTTP artifact —
 * `pnpm --filter @hisab/mcp-payments verify`. Boots the real http server, drives
 * the real KhaltiClient code path against the local stub gateway (NO network, NO
 * merchant key, NO Anthropic API), and proves — over a real MCP client and the
 * real GET callback — that the money-critical invariants hold and the lies bounce.
 *
 * Verdicts: PASS | FAIL | BLOCKED. Exit non-zero on any non-PASS.
 * Invariants proven:
 *   - consent gate: initiate without owner_approved never reaches the gateway
 *   - lookup is the only truth: a verify before payment records nothing
 *   - amount reconciliation: a tampered gateway amount → amount_mismatch, no sale
 *   - exactly-once: a completed payment books ONE confirmed gateway sale; replays don't double it
 *   - forged callback: a hand-crafted "status=Completed" with an unpaid pidx records nothing
 *   - MCP auth still required on the callback-bearing server
 */
import postgres from 'postgres';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createDb } from '@hisab/db';
import { createTenantToken } from '@hisab/mcp-ledger';
import { buildPaymentsHttpServer } from './http.js';
import { KhaltiClient } from './khalti.js';
import { startKhaltiStub } from './khalti-stub.js';

const PORT = 8898;
const BASE = `http://127.0.0.1:${PORT}`;
const URL_MCP = `${BASE}/mcp`;
const SERVICE_TOKEN = 'verify-payments-service-token';
const SIGNING_SECRET = 'verify-payments-signing-secret';
const STUB_SECRET = 'verify-khalti-secret';

const ADMIN_URL = process.env['ADMIN_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/hisabkitab';
const APP_URL = process.env['DATABASE_URL'] ?? 'postgres://hisab_app:hisab_app_dev@localhost:5432/hisabkitab';
const ORCH_URL =
  process.env['CALLBACK_DATABASE_URL'] ?? 'postgres://hisab_orch:hisab_orch_dev@localhost:5432/hisabkitab';

type Verdict = 'PASS' | 'FAIL' | 'BLOCKED';
const results: Array<{ name: string; verdict: Verdict; detail: string }> = [];
const record = (name: string, verdict: Verdict, detail: string) => {
  results.push({ name, verdict, detail });
  console.log(`[${verdict}] ${name}\n       ${detail}\n`);
};

async function ensureTenant(adminSql: postgres.Sql): Promise<string> {
  const [row] = await adminSql`
    INSERT INTO tenants (business_name, pan_or_vat_no, status)
    VALUES ('Verify Payments Pasal', '300000005', 'active')
    ON CONFLICT DO NOTHING RETURNING id`;
  if (row) return row['id'] as string;
  const [existing] =
    await adminSql`SELECT id FROM tenants WHERE business_name = 'Verify Payments Pasal' LIMIT 1`;
  return existing!['id'] as string;
}

const salesCountFor = async (adminSql: postgres.Sql, ref: string): Promise<number> => {
  const rows = await adminSql`SELECT count(*)::int AS n FROM sales WHERE gateway_ref = ${ref}`;
  return rows[0]?.['n'] as number;
};

async function main(): Promise<void> {
  const adminSql = postgres(ADMIN_URL, { max: 1 });
  const appHandle = createDb(APP_URL, 4);
  const orchHandle = createDb(ORCH_URL, 2);
  const stub = await startKhaltiStub(STUB_SECRET);
  const khalti = new KhaltiClient({ secretKey: STUB_SECRET, origin: stub.origin });

  const tenantId = await ensureTenant(adminSql);
  const server = buildPaymentsHttpServer({
    serviceToken: SERVICE_TOKEN,
    signingSecret: SIGNING_SECRET,
    appDb: appHandle.db,
    orchDb: orchHandle.db,
    khalti,
    returnUrl: `${BASE}/payments/khalti/return`,
    websiteUrl: 'https://hisabkitab.example',
  });
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));

  const connectMcp = async (token: string): Promise<Client> => {
    const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), {
      requestInit: {
        headers: {
          authorization: `Bearer ${SERVICE_TOKEN}`,
          'x-hisab-tenant': token,
        },
      },
    });
    const client = new Client({ name: 'verify-payments', version: '0.0.0' });
    await client.connect(transport);
    return client;
  };
  const callTool = async <T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; value: T | string }> => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text?: string }>)[0]?.text ?? '';
    if (res.isError) return { isError: true, value: text };
    return { isError: false, value: JSON.parse(text) as T };
  };

  try {
    const client = await connectMcp(createTenantToken(tenantId, SIGNING_SECRET));

    // PROBE: consent gate — initiate without owner_approved must not reach the gateway
    try {
      const before = stub.payments.size;
      const r = await callTool(client, 'initiate_payment', { amount_paisa: 904000, purpose: 'momo' });
      const reached = stub.payments.size > before;
      record(
        'PROBE: initiate without owner_approved is refused and never reaches Khalti',
        r.isError && !reached ? 'PASS' : 'FAIL',
        `isError=${r.isError}, gatewayHit=${reached}`,
      );
    } catch (err) {
      record('PROBE: initiate without owner_approved is refused', 'BLOCKED', String(err));
    }

    // happy: initiate with consent → verify-before-pay records nothing → complete books ONE sale
    let pidx = '';
    try {
      const init = await callTool<{ ok: boolean; pidx: string; payment_url: string }>(
        client,
        'initiate_payment',
        { amount_paisa: 904000, purpose: 'momo set x4', owner_approved: true },
      );
      if (!init.isError && typeof init.value === 'object' && init.value.ok && init.value.payment_url.includes(init.value.pidx)) {
        pidx = init.value.pidx;
        record('initiate_payment with consent returns a shareable Khalti link', 'PASS', `pidx=${pidx}`);
      } else {
        record('initiate_payment with consent returns a shareable Khalti link', 'FAIL', JSON.stringify(init.value));
      }
    } catch (err) {
      record('initiate_payment with consent', 'BLOCKED', String(err));
    }

    if (pidx) {
      // PROBE: lookup is the only truth — verify before the payer pays records nothing
      try {
        const r = await callTool<{ ok: boolean }>(client, 'verify_payment', { pidx });
        const sales = await salesCountFor(adminSql, pidx);
        const ok = !r.isError && typeof r.value === 'object' && r.value.ok === false && sales === 0;
        record('PROBE: verify before payment records NOTHING (lookup says Initiated)', ok ? 'PASS' : 'FAIL', `sales=${sales}`);
      } catch (err) {
        record('PROBE: verify before payment records nothing', 'BLOCKED', String(err));
      }

      // complete → exactly ONE confirmed gateway sale with the exact VAT-inclusive split
      try {
        stub.completePayment(pidx);
        const r = await callTool<{ ok: boolean; status: string; sale_id: string; amount_excl_vat_paisa: number; vat_paisa: number }>(
          client,
          'verify_payment',
          { pidx },
        );
        const v = r.value as { ok: boolean; status: string; amount_excl_vat_paisa: number; vat_paisa: number };
        const sales = await salesCountFor(adminSql, pidx);
        const ok = !r.isError && v.status === 'completed' && v.amount_excl_vat_paisa === 800000 && v.vat_paisa === 104000 && sales === 1;
        record('completed payment books ONE confirmed gateway sale (exact VAT split)', ok ? 'PASS' : 'FAIL', `split=${v.amount_excl_vat_paisa}+${v.vat_paisa}, sales=${sales}`);
      } catch (err) {
        record('completed payment books one confirmed gateway sale', 'BLOCKED', String(err));
      }

      // PROBE: re-verifying does NOT create a second sale (exactly-once)
      try {
        await callTool(client, 'verify_payment', { pidx });
        const sales = await salesCountFor(adminSql, pidx);
        record('PROBE: re-verifying does not double-record (exactly-once)', sales === 1 ? 'PASS' : 'FAIL', `sales=${sales}`);
      } catch (err) {
        record('PROBE: exactly-once on re-verify', 'BLOCKED', String(err));
      }
    }

    // PROBE: tampered gateway amount → amount_mismatch, NEVER completed
    try {
      const init = await callTool<{ pidx: string }>(client, 'initiate_payment', { amount_paisa: 500000, purpose: 'tampered', owner_approved: true });
      const tp = (init.value as { pidx: string }).pidx;
      stub.completePayment(tp);
      stub.tamperLookupAmount(tp, 400000); // gateway lies
      const r = await callTool<{ ok: boolean; status: string }>(client, 'verify_payment', { pidx: tp });
      const v = r.value as { ok: boolean; status: string };
      const sales = await salesCountFor(adminSql, tp);
      record('PROBE: tampered gateway amount → amount_mismatch, no sale', v.ok === false && v.status === 'amount_mismatch' && sales === 0 ? 'PASS' : 'FAIL', `status=${v.status}, sales=${sales}`);
    } catch (err) {
      record('PROBE: amount reconciliation', 'BLOCKED', String(err));
    }

    await client.close();

    // PROBE: forged callback — hand-crafted "status=Completed" with an UNPAID pidx records nothing
    try {
      const c2 = await connectMcp(createTenantToken(tenantId, SIGNING_SECRET));
      const init = await callTool<{ pidx: string }>(c2, 'initiate_payment', { amount_paisa: 226000, purpose: 'forged callback', owner_approved: true });
      const fp = (init.value as { pidx: string }).pidx;
      await c2.close();
      const res = await fetch(`${BASE}/payments/khalti/return?pidx=${fp}&status=Completed&amount=226000&transaction_id=fake`);
      await res.text();
      const sales = await salesCountFor(adminSql, fp);
      record('PROBE: forged return-URL "Completed" with an unpaid pidx records nothing', res.status === 200 && sales === 0 ? 'PASS' : 'FAIL', `http=${res.status}, sales=${sales}`);
    } catch (err) {
      record('PROBE: forged callback', 'BLOCKED', String(err));
    }

    // PROBE: the MCP endpoint still requires auth (callback route doesn't weaken it)
    try {
      const res = await fetch(URL_MCP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }) });
      await res.text();
      record('PROBE: unauthenticated MCP call is rejected (401)', res.status === 401 ? 'PASS' : 'FAIL', `http=${res.status}`);
    } catch (err) {
      record('PROBE: MCP auth required', 'BLOCKED', String(err));
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await stub.close();
    await appHandle.close();
    await orchHandle.close();
    await adminSql.end({ timeout: 5 });
  }

  const bad = results.filter((r) => r.verdict !== 'PASS').length;
  console.log(`${results.length} checks: ${results.length - bad} PASS, ${bad} not-PASS`);
  process.exitCode = bad > 0 ? 1 : 0;
}

void main();
