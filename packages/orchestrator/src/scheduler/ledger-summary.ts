/**
 * Production ReturnSummaryProvider: call generate_return_summary on the real
 * Ledger MCP over Streamable HTTP, authenticated with a freshly minted signed
 * tenant token (the same bearer the vault injects). Deterministic ledger tool —
 * NO agent, NO Anthropic API spend. One short-lived MCP client per call.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTenantToken } from '@hisab/mcp-ledger';
import type { ReturnSummaryProvider } from './reminder-job.js';

export interface LedgerSummaryDeps {
  ledgerMcpUrl: string;
  signingSecret: string;
  /** token TTL for the one-shot call; default 5 min. */
  ttlSeconds?: number;
}

interface ReturnSummaryResult {
  net_payable_paisa: number;
  is_nil: boolean;
  filing_deadline_ad: string;
}

export function createLedgerSummaryProvider(deps: LedgerSummaryDeps): ReturnSummaryProvider {
  return async (tenantId, bsYear, bsMonth) => {
    const token = createTenantToken(tenantId, deps.signingSecret, deps.ttlSeconds ?? 300);
    const transport = new StreamableHTTPClientTransport(new URL(deps.ledgerMcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'hisab-scheduler', version: '0.0.0' });
    await client.connect(transport);
    try {
      const res = await client.callTool({
        name: 'generate_return_summary',
        arguments: { bs_year: bsYear, bs_month: bsMonth },
      });
      if (res.isError) {
        const text = (res.content as Array<{ text?: string }>)[0]?.text ?? 'unknown error';
        throw new Error(`generate_return_summary failed: ${text}`);
      }
      const text = (res.content as Array<{ text?: string }>)[0]?.text ?? '{}';
      const parsed = JSON.parse(text) as ReturnSummaryResult;
      return {
        netPayablePaisa: BigInt(parsed.net_payable_paisa),
        isNil: parsed.is_nil,
        filingDeadlineAd: parsed.filing_deadline_ad,
      };
    } finally {
      await client.close();
    }
  };
}
