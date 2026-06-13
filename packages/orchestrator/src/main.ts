/**
 * Production boot: config → db (hisab_orch) → WhatsApp client → webhook server.
 *   pnpm --filter @hisab/orchestrator start
 */
import Anthropic from '@anthropic-ai/sdk';
import { createDb } from '@hisab/db';
import { loadConfig } from './config.js';
import { DbGateLogger } from './audit/audit-logger.js';
import { WaClient } from './whatsapp/wa-client.js';
import { SerialQueues } from './whatsapp/router.js';
import { buildServer } from './server.js';
import { startScheduler, type SchedulerHandle } from './scheduler/queue.js';
import { createLedgerSummaryProvider } from './scheduler/ledger-summary.js';

const config = await loadConfig();
const handle = createDb(config.DATABASE_URL);
const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const wa = new WaClient({
  phoneNumberId: config.WA_PHONE_NUMBER_ID,
  accessToken: config.WA_ACCESS_TOKEN,
  ...(config.WA_GRAPH_BASE_URL ? { baseUrl: config.WA_GRAPH_BASE_URL } : {}),
});

const app = buildServer({
  verifyToken: config.WA_WEBHOOK_VERIFY_TOKEN,
  appSecret: config.WA_APP_SECRET,
  deps: {
    anthropic,
    db: handle.db,
    wa,
    gateLogger: new DbGateLogger(config.DATABASE_URL),
    queues: new SerialQueues(),
    agentId: config.AGENT_ID,
    environmentId: config.ENVIRONMENT_ID,
    ledgerMcpUrl: config.LEDGER_MCP_URL,
    signingSecret: config.TENANT_SIGNING_SECRET,
    log: (msg) => console.log(msg),
  },
});

await app.listen({ port: config.PORT, host: '0.0.0.0' });
console.log(`hisab orchestrator webhook listening on :${config.PORT}/webhook`);

// Phase 6: monthly VAT-return reminder scheduler (BullMQ). Runs the worker in
// this process unless SCHEDULER_ENABLED=0 (webhook-only nodes).
let scheduler: SchedulerHandle | undefined;
if (config.SCHEDULER_ENABLED) {
  scheduler = await startScheduler({
    connection: { url: config.REDIS_URL },
    db: handle.db, // hisab_orch — cross-tenant, reminder_log writes
    getReturnSummary: createLedgerSummaryProvider({
      ledgerMcpUrl: config.LEDGER_MCP_URL,
      signingSecret: config.TENANT_SIGNING_SECRET,
    }),
    sendTemplate: (to, name, params) => wa.sendTemplate(to, name, params),
    ...(config.REMINDER_CRON ? { cron: config.REMINDER_CRON } : {}),
    log: (msg) => console.log(`[scheduler] ${msg}`),
  });
  console.log('hisab reminder scheduler started (BullMQ)');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      await scheduler?.close();
      await app.close();
      await handle.close();
      process.exit(0);
    })();
  });
}
