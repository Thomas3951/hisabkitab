/**
 * Build a Payments MCP server bound to ONE tenant (one session = one tenant).
 * tenantId comes from verified signed session metadata in the transport layer
 * (src/http.ts) or directly in tests — NEVER from tool arguments.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createToolHandlers, inputSchemas, toolDescriptions, type PaymentsToolContext } from './tools.js';

export function buildPaymentsServer(ctx: PaymentsToolContext): McpServer {
  const server = new McpServer({ name: 'hisab-payments', version: '0.1.0' });
  const handlers = createToolHandlers(ctx);

  for (const name of Object.keys(inputSchemas) as Array<keyof typeof inputSchemas>) {
    server.registerTool(
      name,
      { description: toolDescriptions[name], inputSchema: inputSchemas[name] },
      async (rawArgs: unknown) => {
        try {
          const args = z.object(inputSchemas[name]).parse(rawArgs ?? {});
          const result = await (handlers[name] as (a: unknown) => Promise<unknown>)(args);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (err) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `${name} failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }
      },
    );
  }
  return server;
}
