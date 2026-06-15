/**
 * Pure unit tests for the subscription billing lifecycle (PRD v2.0 §2). No DB.
 * Adversarial PROBES (CLAUDE.md §8): grace boundary is exact, a lapsed period
 * never silently reactivates, renewal after a lapse does not credit lost days,
 * month-end clamps, cancelled is terminal.
 */
import { describe, expect, it } from 'vitest';
import {
  GRACE_DAYS,
  TRIAL_DAYS,
  RENEWAL_NUDGE_DAYS,
  addDays,
  addMonth,
  daysBetween,
  dunningDecision,
  hasAccess,
  projectStatus,
  renew,
  startTrial,
  BillingError,
  type SubscriptionState,
} from '../src/index.js';

describe('date helpers', () => {
  it('daysBetween + addDays are inverse and signed', () => {
    expect(daysBetween('2026-03-01', '2026-03-08')).toBe(7);
    expect(daysBetween('2026-03-08', '2026-03-01')).toBe(-7);
    expect(addDays('2026-03-01', 7)).toBe('2026-03-08');
  });

  it('addMonth clamps to the last valid day', () => {
    expect(addMonth('2026-01-31')).toBe('2026-02-28'); // 2026 not a leap year
    expect(addMonth('2024-01-31')).toBe('2024-02-29'); // leap year
    expect(addMonth('2026-03-15')).toBe('2026-04-15');
    expect(addMonth('2026-12-15')).toBe('2027-01-15'); // year rollover
  });
});

describe('startTrial', () => {
  it('opens a trial that ends TRIAL_DAYS out with access', () => {
    const s = startTrial('2026-03-01');
    expect(s.status).toBe('trial');
    expect(s.currentPeriodEnd).toBe(addDays('2026-03-01', TRIAL_DAYS));
    expect(hasAccess(s, '2026-03-10')).toBe(true);
  });
});

describe('projectStatus transitions', () => {
  const active: SubscriptionState = { status: 'active', currentPeriodEnd: '2026-03-31' };

  it('stays active inside the period; trial stays trial', () => {
    expect(projectStatus(active, '2026-03-20')).toBe('active');
    expect(projectStatus({ status: 'trial', currentPeriodEnd: '2026-03-31' }, '2026-03-20')).toBe('trial');
  });

  it('on the last covered day is still active (inclusive end)', () => {
    expect(projectStatus(active, '2026-03-31')).toBe('active');
  });

  it('the day after period end becomes past_due', () => {
    expect(projectStatus(active, '2026-04-01')).toBe('past_due');
  });

  it('PROBE: exactly GRACE_DAYS overdue is still past_due; one more day suspends', () => {
    const lastGraceDay = addDays(active.currentPeriodEnd, GRACE_DAYS);
    expect(projectStatus(active, lastGraceDay)).toBe('past_due');
    expect(projectStatus(active, addDays(active.currentPeriodEnd, GRACE_DAYS + 1))).toBe('suspended');
  });

  it('PROBE: a stored "active" never silently stays active once lapsed', () => {
    // Even though the row says active, projection past the grace window suspends it.
    expect(projectStatus(active, '2026-06-01')).toBe('suspended');
    expect(hasAccess(active, '2026-06-01')).toBe(false);
  });

  it('cancelled is terminal', () => {
    const c: SubscriptionState = { status: 'cancelled', currentPeriodEnd: '2099-01-01' };
    expect(projectStatus(c, '2026-03-01')).toBe('cancelled');
    expect(hasAccess(c, '2026-03-01')).toBe(false);
  });
});

describe('renew (prepaid month)', () => {
  it('extends one month from the period end when paying early (stacks)', () => {
    const s: SubscriptionState = { status: 'active', currentPeriodEnd: '2026-03-31' };
    expect(renew(s, '2026-03-20')).toEqual({ status: 'active', currentPeriodEnd: '2026-04-30' });
  });

  it('PROBE: paying AFTER a lapse extends from today, not the stale end (no free days)', () => {
    const lapsed: SubscriptionState = { status: 'past_due', currentPeriodEnd: '2026-03-31' };
    // owner pays on Apr 20 — new period runs a month from Apr 20, not Mar 31.
    expect(renew(lapsed, '2026-04-20')).toEqual({ status: 'active', currentPeriodEnd: '2026-05-20' });
  });

  it('reactivates a suspended subscription to active', () => {
    const susp: SubscriptionState = { status: 'suspended', currentPeriodEnd: '2026-01-01' };
    expect(renew(susp, '2026-04-20').status).toBe('active');
  });

  it('PROBE: cannot renew a cancelled subscription', () => {
    const c: SubscriptionState = { status: 'cancelled', currentPeriodEnd: '2026-01-01' };
    expect(() => renew(c, '2026-04-20')).toThrow(BillingError);
  });
});

describe('dunningDecision', () => {
  const active: SubscriptionState = { status: 'active', currentPeriodEnd: '2026-03-31' };

  it('nudges within the renewal window, not before', () => {
    expect(dunningDecision(active, addDays('2026-03-31', -(RENEWAL_NUDGE_DAYS + 1))).stage).toBeNull();
    expect(dunningDecision(active, addDays('2026-03-31', -RENEWAL_NUDGE_DAYS)).stage).toBe('renewal_due_soon');
    expect(dunningDecision(active, '2026-03-31').stage).toBe('renewal_due_soon');
  });

  it('announces expiry (past_due) the day after lapse', () => {
    const d = dunningDecision(active, '2026-04-01');
    expect(d.stage).toBe('expired');
    expect(d.status).toBe('past_due');
  });

  it('announces suspension after grace, and latches on the period end', () => {
    const d = dunningDecision(active, addDays('2026-03-31', GRACE_DAYS + 1));
    expect(d.stage).toBe('suspended');
    expect(d.status).toBe('suspended');
    expect(d.forPeriodEnd).toBe('2026-03-31'); // stable latch key
  });

  it('says nothing for a healthy subscription far from renewal', () => {
    expect(dunningDecision(active, '2026-03-10').stage).toBeNull();
  });
});
