/**
 * Retry with exponential backoff + jitter for TRANSIENT failures (PRD v1.0 §16
 * Phase 7 "error/retry"). Used for outbound WhatsApp/Graph sends and other
 * idempotent-ish network calls that fail with a 429 / 5xx / network blip.
 *
 * Only RETRYABLE errors are retried — a 400/401/403 (our bug, bad token) fails
 * fast, because retrying it just burns time and rate-limit budget. A money WRITE
 * is never retried here; idempotency for writes lives in the DB latches.
 */
export interface RetryOptions {
  /** total attempts incl. the first (default 3). */
  attempts?: number;
  /** base backoff ms (default 300); delay = base * 2^(n-1) + jitter. */
  baseMs?: number;
  /** cap on a single backoff (default 5000). */
  maxDelayMs?: number;
  /** classify an error as worth retrying (default: 429/5xx/network). */
  isRetryable?: (err: unknown) => boolean;
  /** injected sleep (tests pass a no-op / fake timer). */
  sleep?: (ms: number) => Promise<void>;
  /** injected jitter in [0,1) (tests pass () => 0 for determinism). */
  random?: () => number;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** HTTP-status-bearing errors (WaError/KhaltiError) expose `.status`. */
function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown })?.status;
  return typeof s === 'number' ? s : undefined;
}

/** Default: retry network errors and 429 / 5xx; never 4xx (except 429). */
export function defaultIsRetryable(err: unknown): boolean {
  const status = statusOf(err);
  if (status === undefined) return true; // no HTTP status → treat as a network blip
  if (status === 429) return true;
  return status >= 500 && status <= 599;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 300;
  const maxDelayMs = opts.maxDelayMs ?? 5000;
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !isRetryable(err)) throw err;
      const backoff = Math.min(baseMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = backoff * 0.25 * random(); // up to +25%
      const delay = Math.round(backoff + jitter);
      opts.onRetry?.(attempt, delay, err);
      await sleep(delay);
    }
  }
  throw lastErr;
}
