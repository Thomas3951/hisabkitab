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

const config = await loadConfig();
const handle = createDb(config.DATABASE_URL);
const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const app = buildServer({
  verifyToken: config.WA_WEBHOOK_VERIFY_TOKEN,
  appSecret: config.WA_APP_SECRET,
  deps: {
    anthropic,
    db: handle.db,
    wa: new WaClient({
      phoneNumberId: config.WA_PHONE_NUMBER_ID,
      accessToken: config.WA_ACCESS_TOKEN,
      ...(config.WA_GRAPH_BASE_URL ? { baseUrl: config.WA_GRAPH_BASE_URL } : {}),
    }),
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
