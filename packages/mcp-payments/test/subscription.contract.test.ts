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
