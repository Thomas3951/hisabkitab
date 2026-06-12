/**
 * Pairing + dedupe against REAL Postgres as hisab_orch (RLS-bypassing webhook
 * role from migration 0002). PROBES: wrong/expired/reused codes, webhook retry.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, schema, type DbHandle } from '@hisab/db';
import type Anthropic from '@anthropic-ai/sdk';
import {
  findTenantBySender,
  handleUnknownSender,
  issuePairingCode,
  ONBOARDING_PROMPT,
} from '../src/onboarding/pairing.js';
import { processInbound, SerialQueues, UNSUPPORTED_REPLY, type RouterDeps } from '../src/whatsapp/router.js';
import { MemoryGateLogger } from '../src/audit/audit-logger.js';
import type { WaClient } from '../src/whatsapp/wa-client.js';
import type { InboundMessage } from '../src/whatsapp/inbound.js';
import { ADMIN_URL, ORCH_URL } from './urls.js';

let admin: DbHandle;
let orch: DbHandle;
let tenantId: string;

beforeAll(async () => {
  admin = createDb(ADMIN_URL, 2);
  orch = createDb(ORCH_URL, 2);
  const [t] = await admin.db
    .insert(schema.tenants)
    .values({ businessName: 'Karki Cafe', panOrVatNo: '600000001' })
    .returning({ id: schema.tenants.id });
  tenantId = (t as { id: string }).id;
});

afterAll(async () => {
  await orch.close();
  await admin.close();
});

const textMsg = (id: string, from: string, body: string): InboundMessage => ({
  waMessageId: id,
  fromE164: from,
  timestamp: '0',
  kind: 'text',
  text: body,
});

function makeDeps(sent: { to: string; body: string }[]): RouterDeps {
  return {
    anthropic: {} as Anthropic, // never reached in these paths
    db: orch.db,
    wa: {
      sendText: vi.fn(async (to: string, body: string) => {
        sent.push({ to, body });
      }),
    } as unknown as WaClient,
    gateLogger: new MemoryGateLogger(),
    queues: new SerialQueues(),
    agentId: 'agent_test',
    environmentId: 'env_test',
    ledgerMcpUrl: 'https://ledger.example/mcp',
    signingSecret: 'test-secret',
  };
}

describe('pairing flow (PRD v1.0 §13)', () => {
  it('binds the number, activates the tenant, consumes the code, audit-logs', async () => {
    const code = await issuePairingCode(orch.db, tenantId);
    const outcome = await handleUnknownSender(orch.db, '+9779801111111', `start ${code}`);
    expect(outcome).toEqual({ kind: 'paired', tenantId, businessName: 'Karki Cafe' });

    const [t] = await orch.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    expect(t).toMatchObject({ status: 'active', whatsappE164: '+9779801111111' });

    expect(await findTenantBySender(orch.db, '+9779801111111')).toEqual({
      tenantId,
      businessName: 'Karki Cafe',
    });

    const audits = await admin.db.select().from(schema.auditLog).where(eq(schema.auditLog.tenantId, tenantId));
    expect(audits.some((a) => a.action === 'whatsapp_paired')).toBe(true);
  });

  it('PROBE: a consumed code cannot pair a second number', async () => {
    const code = await issuePairingCode(orch.db, tenantId);
    await handleUnknownSender(orch.db, '+100', `START ${code}`);
    expect(await handleUnknownSender(orch.db, '+200', `START ${code}`)).toEqual({ kind: 'invalid_code' });
  });

  it('PROBE: wrong and expired codes are rejected; random text is no_code', async () => {
    expect(await handleUnknownSender(orch.db, '+300', 'START 0000')).toEqual({ kind: 'invalid_code' });
    expect(await handleUnknownSender(orch.db, '+300', 'hello?')).toEqual({ kind: 'no_code' });

    const code = await issuePairingCode(orch.db, tenantId);
    await orch.db
      .update(schema.pairingCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.pairingCodes.code, code));
    expect(await handleUnknownSender(orch.db, '+300', `START ${code}`)).toEqual({ kind: 'invalid_code' });
  });
});

describe('processInbound routing', () => {
  it('PROBE: a webhook retry (same wa message id) is processed exactly once', async () => {
    const sent: { to: string; body: string }[] = [];
    const deps = makeDeps(sent);
    const msg = textMsg('wamid.dup1', '+9779809999999', 'hello');
    expect(await processInbound(deps, msg)).toBe(true);
    expect(await processInbound(deps, msg)).toBe(false); // dedupe
    expect(sent).toHaveLength(1); // one onboarding prompt, not two
  });

  it('unknown sender without a code gets the onboarding prompt', async () => {
    const sent: { to: string; body: string }[] = [];
    await processInbound(makeDeps(sent), textMsg('wamid.ob1', '+9779808888888', 'namaste'));
    expect(sent[0]?.body).toBe(ONBOARDING_PROMPT);
  });

  it('voice notes get the coming-soon reply (never silently dropped)', async () => {
    const [t2] = await admin.db
      .insert(schema.tenants)
      .values({ businessName: 'Thapa Suppliers', panOrVatNo: '600000002' })
      .returning({ id: schema.tenants.id });
    const code = await issuePairingCode(orch.db, (t2 as { id: string }).id);
    await handleUnknownSender(orch.db, '+9779807777777', `START ${code}`);

    const sent: { to: string; body: string }[] = [];
    await processInbound(makeDeps(sent), {
      waMessageId: 'wamid.audio1',
      fromE164: '+9779807777777',
      timestamp: '0',
      kind: 'audio',
      media: { mediaId: 'm', mimeType: 'audio/ogg' },
    });
    expect(sent[0]?.body).toBe(UNSUPPORTED_REPLY);
  });
});

describe('SerialQueues', () => {
  it('serializes per key, runs keys concurrently, survives failures', async () => {
    const q = new SerialQueues();
    const order: string[] = [];
    const slow = (label: string, ms: number) => async () => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(label);
      return label;
    };
    const failing = async () => {
      throw new Error('boom');
    };

    const results = await Promise.allSettled([
      q.run('a', slow('a1', 30)),
      q.run('a', failing),
      q.run('a', slow('a2', 1)),
      q.run('b', slow('b1', 5)),
    ]);
    expect(order).toEqual(['b1', 'a1', 'a2']); // b ran while a1 was in flight; a2 after a1
    expect(results[1]?.status).toBe('rejected'); // failure surfaced, queue kept going
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'a2' });
  });
});
