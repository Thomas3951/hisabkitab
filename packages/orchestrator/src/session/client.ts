/**
 * Orchestrator session client (PRD v1.1 Phase 2).
 *
 * One session = one tenant. The Pre-delivery Audit Gate sits in the relay path:
 * every `agent.message` is audited against the turn's tool-result evidence
 * BEFORE delivery. Held messages are never relayed — the agent is instructed to
 * re-verify or ask the owner; after MAX_HOLDS_PER_TURN a figure-free fallback
 * is delivered instead. Every gate decision is logged.
 */
import type Anthropic from '@anthropic-ai/sdk';
import {
  addToolResultEvidence,
  auditOutbound,
  correctiveInstruction,
  HELD_FALLBACK_MESSAGE,
  newTurnEvidence,
} from '../audit/gate.js';
import type { GateLogger } from '../audit/audit-logger.js';

const MAX_HOLDS_PER_TURN = 2;

export interface StartSessionOptions {
  agentId: string;
  /** Pin a version for reproducibility; omit for latest. */
  agentVersion?: number;
  environmentId: string;
  vaultId: string;
  tenantId: string;
  title?: string;
}

export async function startTenantSession(
  client: Anthropic,
  opts: StartSessionOptions,
): Promise<{ sessionId: string }> {
  const session = await client.beta.sessions.create({
    agent:
      opts.agentVersion !== undefined
        ? { type: 'agent', id: opts.agentId, version: opts.agentVersion }
        : opts.agentId,
    environment_id: opts.environmentId,
    vault_ids: [opts.vaultId],
    title: opts.title ?? `hisab tenant ${opts.tenantId}`,
    metadata: { tenant_id: opts.tenantId, project: 'hisabkitab' },
  });
  return { sessionId: session.id };
}

export interface TurnOptions {
  tenantId: string;
  logger: GateLogger;
  /** Relay one gate-passed message to the owner (Phase 3 wires this to WhatsApp). */
  deliver: (text: string) => void | Promise<void>;
  /** Hard cap on stream wait, ms (long Opus turns are normal; default 10 min). */
  timeoutMs?: number;
}

export interface TurnResult {
  delivered: string[];
  holds: number;
  status: 'idle' | 'terminated' | 'timeout';
  errors: string[];
}

/**
 * Send one owner message and drain the stream until a terminal idle.
 * Stream-first ordering; idle with `requires_action` is not terminal; an idle
 * that lands while a corrective retry is pending is also not terminal.
 */
export async function runTurn(
  client: Anthropic,
  sessionId: string,
  userText: string,
  opts: TurnOptions,
): Promise<TurnResult> {
  const result: TurnResult = { delivered: [], holds: 0, status: 'idle', errors: [] };
  const deadline = Date.now() + (opts.timeoutMs ?? 600_000);

  const stream = await client.beta.sessions.events.stream(sessionId);
  await client.beta.sessions.events.send(sessionId, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: userText }] }],
  });

  let evidence = newTurnEvidence();
  let awaitingRetry = false;

  for await (const event of stream) {
    if (Date.now() > deadline) {
      result.status = 'timeout';
      break;
    }
    switch (event.type) {
      case 'agent.tool_result':
      case 'agent.mcp_tool_result':
        addToolResultEvidence(evidence, JSON.stringify(event.content ?? ''), {
          isError: event.is_error ?? false,
        });
        break;

      case 'agent.message': {
        const text = event.content.map((b) => b.text).join('\n');
        const decision = auditOutbound(text, evidence);
        await opts.logger.log({
          tenantId: opts.tenantId,
          sessionId,
          decision,
          messagePreview: text,
        });
        if (decision.action === 'deliver') {
          result.delivered.push(text);
          await opts.deliver(text);
        } else {
          result.holds += 1;
          if (result.holds <= MAX_HOLDS_PER_TURN) {
            awaitingRetry = true;
            evidence = newTurnEvidence(); // the retry must re-derive its evidence
            await client.beta.sessions.events.send(sessionId, {
              events: [
                {
                  type: 'user.message',
                  content: [{ type: 'text', text: correctiveInstruction(decision) }],
                },
              ],
            });
          } else {
            result.delivered.push(HELD_FALLBACK_MESSAGE);
            await opts.deliver(HELD_FALLBACK_MESSAGE);
          }
        }
        break;
      }

      case 'session.error':
        result.errors.push(JSON.stringify(event));
        break;

      case 'session.status_terminated':
        result.status = 'terminated';
        return result;

      case 'session.status_idle':
        if (event.stop_reason.type === 'requires_action') break;
        if (awaitingRetry) {
          // idle for the held turn; the queued corrective message is next
          awaitingRetry = false;
          break;
        }
        return result;

      default:
        break;
    }
  }
  return result;
}
