/**
 * Per-tenant token-bucket rate limiter (PRD v1.1 §7 / v2.0 §7 — "Cost is a
 * feature: per-tenant budgets, rate limits"). A flood of inbound messages from
 * one number must not run unbounded agent turns (each turn costs tokens). The
 * bucket refills at a steady rate; an over-limit message is dropped with a
 * friendly nudge instead of starting a session.
 *
 * In-memory by design (one bucket per tenant, per process) — simple, allocation-
 * free on the hot path, and sufficient for the pilot's single orchestrator. A
 * Redis-backed bucket can replace this behind the same interface when there are
 * multiple orchestrator replicas (the burst window is short, so per-process is
 * a safe approximation until then).
 */
export interface RateLimiterOptions {
  /** bucket capacity = max burst (default 8 messages). */
  capacity?: number;
  /** tokens refilled per second (default 0.2 = 1 every 5s, ~12/min sustained). */
  refillPerSec?: number;
  /** injected clock (ms); tests pass a controllable now(). */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateDecision {
  allowed: boolean;
  /** tokens left after this decision (for observability). */
  remaining: number;
  /** ms until at least one token is available (0 when allowed). */
  retryAfterMs: number;
}

export class TenantRateLimiter {
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: RateLimiterOptions = {}) {
    this.capacity = opts.capacity ?? 8;
    this.refillPerSec = opts.refillPerSec ?? 0.2;
    this.now = opts.now ?? Date.now;
  }

  /** Consume one token for `key` (the tenant/sender). Returns the decision. */
  take(key: string, cost = 1): RateDecision {
    const t = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefillMs: t };
      this.buckets.set(key, bucket);
    }
    // refill based on elapsed time
    const elapsedSec = (t - bucket.lastRefillMs) / 1000;
    if (elapsedSec > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
      bucket.lastRefillMs = t;
    }
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }
    const deficit = cost - bucket.tokens;
    const retryAfterMs = Math.ceil((deficit / this.refillPerSec) * 1000);
    return { allowed: false, remaining: Math.floor(bucket.tokens), retryAfterMs };
  }

  /** Drop a tenant's bucket (e.g. after data deletion). */
  forget(key: string): void {
    this.buckets.delete(key);
  }
}

/** Friendly reply when a sender is over their rate limit (never silent). */
export const RATE_LIMITED_REPLY =
  "🙏 You're sending messages very quickly — I'm catching up. Please give me a moment " +
  'and resend your last message in a few seconds.';
