/**
 * Resilience utilities (PRD §7 Phase 7): retry/backoff + per-tenant rate limit.
 * Deterministic — injected sleep/clock/jitter, no real timers. Probes included.
 */
import { describe, expect, it, vi } from 'vitest';
import { withRetry, defaultIsRetryable } from '../src/resilience/retry.js';
import { TenantRateLimiter, RATE_LIMITED_REPLY } from '../src/resilience/rate-limit.js';

const noSleep = () => Promise.resolve();
const noJitter = () => 0;

describe('withRetry', () => {
  it('returns on first success without sleeping', async () => {
    const fn = vi.fn(async () => 'ok');
    const sleep = vi.fn(noSleep);
    expect(await withRetry(fn, { sleep, random: noJitter })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a transient failure then succeeds (exponential backoff)', async () => {
    let calls = 0;
    const delays: number[] = [];
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('503'), { status: 503 });
      return 'recovered';
    });
    const result = await withRetry(fn, {
      attempts: 3,
      baseMs: 100,
      sleep: async (ms) => void delays.push(ms),
      random: noJitter,
    });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 200]); // 100*2^0, 100*2^1, no jitter
  });

  it('PROBE: a non-retryable 400 fails FAST (no retries, no sleep)', async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('bad request'), { status: 400 });
    });
    await expect(withRetry(fn, { sleep, random: noJitter })).rejects.toThrow(/bad request/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('PROBE: gives up after exhausting attempts and rethrows the last error', async () => {
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('still 500'), { status: 500 });
    });
    await expect(withRetry(fn, { attempts: 3, sleep: noSleep, random: noJitter })).rejects.toThrow(/still 500/);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('classifies retryable vs not (429/5xx/network yes; 4xx no)', () => {
    expect(defaultIsRetryable(Object.assign(new Error(), { status: 429 }))).toBe(true);
    expect(defaultIsRetryable(Object.assign(new Error(), { status: 502 }))).toBe(true);
    expect(defaultIsRetryable(new Error('ECONNRESET'))).toBe(true); // no status
    expect(defaultIsRetryable(Object.assign(new Error(), { status: 401 }))).toBe(false);
    expect(defaultIsRetryable(Object.assign(new Error(), { status: 404 }))).toBe(false);
  });
});

describe('TenantRateLimiter', () => {
  it('allows a burst up to capacity, then blocks', () => {
    const t = 1_000_000;
    const rl = new TenantRateLimiter({ capacity: 3, refillPerSec: 0.2, now: () => t });
    expect(rl.take('A').allowed).toBe(true);
    expect(rl.take('A').allowed).toBe(true);
    expect(rl.take('A').allowed).toBe(true);
    const blocked = rl.take('A');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('PROBE: refills over time — a blocked sender recovers after waiting', () => {
    let t = 0;
    const rl = new TenantRateLimiter({ capacity: 2, refillPerSec: 0.5, now: () => t }); // 1 token / 2s
    expect(rl.take('A').allowed).toBe(true);
    expect(rl.take('A').allowed).toBe(true);
    expect(rl.take('A').allowed).toBe(false); // empty
    t += 2000; // 2s → +1 token
    expect(rl.take('A').allowed).toBe(true);
    expect(rl.take('A').allowed).toBe(false);
  });

  it('PROBE: one noisy tenant does not exhaust another tenant’s budget (isolation)', () => {
    const t = 0;
    const rl = new TenantRateLimiter({ capacity: 2, refillPerSec: 0.1, now: () => t });
    rl.take('noisy');
    rl.take('noisy');
    expect(rl.take('noisy').allowed).toBe(false); // noisy is throttled
    expect(rl.take('quiet').allowed).toBe(true); // quiet is unaffected
    expect(rl.take('quiet').allowed).toBe(true);
  });

  it('does not refill beyond capacity after a long idle', () => {
    let t = 0;
    const rl = new TenantRateLimiter({ capacity: 3, refillPerSec: 1, now: () => t });
    rl.take('A'); // 2 left
    t += 1_000_000; // very long idle
    // capacity is the ceiling: 3 takes succeed, the 4th blocks
    expect(rl.take('A').allowed).toBe(true);
    expect(rl.take('A').allowed).toBe(true);
    expect(rl.take('A').allowed).toBe(true);
    expect(rl.take('A').allowed).toBe(false);
  });

  it('forget() drops a bucket (used after data deletion)', () => {
    const t = 0;
    const rl = new TenantRateLimiter({ capacity: 1, refillPerSec: 0.001, now: () => t });
    rl.take('A');
    expect(rl.take('A').allowed).toBe(false);
    rl.forget('A');
    expect(rl.take('A').allowed).toBe(true); // fresh bucket
  });

  it('has a friendly over-limit reply (never silent)', () => {
    expect(RATE_LIMITED_REPLY).toMatch(/moment|quickly/i);
  });
});
