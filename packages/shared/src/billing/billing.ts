/**
 * Subscription billing lifecycle (PRD v2.0 §2) — PURE functions, no DB/IO.
 *
 * A subscription is a PREPAID PERIOD: the owner pays for a month up front and a
 * completed payment extends `currentPeriodEnd`. There is no card-on-file auto-debit
 * (Nepal), so when the period lapses the owner must pay again or the subscription
 * walks down the lifecycle:
 *
 *   trial ──pay──▶ active ──period lapses──▶ past_due ──grace elapses──▶ suspended
 *     │                                          │                           │
 *     └────────── period lapses ─────────────────┘                    pay ──▶ active
 *   (a suspended/past_due tenant keeps READ access; paying reactivates.)
 *   cancelled is terminal-by-owner; never auto-entered.
 *
 * The verdict here is advisory: the tool/dunning pass persists it. All date math
 * is on ISO `YYYY-MM-DD` strings (matching the DB `date` columns) to avoid TZ drift.
 */

export type SubscriptionStatus = 'trial' | 'active' | 'past_due' | 'suspended' | 'cancelled';

/** Days a lapsed subscription stays in past_due (read access kept) before suspension. */
export const GRACE_DAYS = 7;
/** Default free trial length when a tenant onboards. */
export const TRIAL_DAYS = 14;
/** How many days before period end the first renewal nudge goes out. */
export const RENEWAL_NUDGE_DAYS = 3;

export interface SubscriptionState {
  status: SubscriptionStatus;
  /** ISO YYYY-MM-DD: last day the current paid/trial period covers (inclusive). */
  currentPeriodEnd: string;
}

// ---------------------------------------------------------------- date helpers (pure)
const MS_PER_DAY = 86_400_000;

/** Parse an ISO YYYY-MM-DD to a UTC-midnight Date (calendar-only, no TZ surprises). */
function parseIso(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) throw new BillingError(`invalid ISO date: ${iso}`);
  return Date.UTC(y, m - 1, d);
}

function toIso(utcMs: number): string {
  const dt = new Date(utcMs);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** Whole calendar days from `a` to `b` (b - a); negative if b is before a. */
export function daysBetween(aIso: string, bIso: string): number {
  return Math.round((parseIso(bIso) - parseIso(aIso)) / MS_PER_DAY);
}

export function addDays(iso: string, days: number): string {
  return toIso(parseIso(iso) + days * MS_PER_DAY);
}

/** Add one calendar month, clamping to the last valid day (e.g. Jan 31 + 1mo → Feb 28/29). */
export function addMonth(iso: string): string {
  const base = new Date(parseIso(iso));
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  const d = base.getUTCDate();
  const lastOfNext = new Date(Date.UTC(y, m + 2, 0)).getUTCDate(); // day 0 of m+2 = last of m+1
  return toIso(Date.UTC(y, m + 1, Math.min(d, lastOfNext)));
}

export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingError';
  }
}

// ---------------------------------------------------------------- lifecycle

/** A fresh trial: active features, period ends TRIAL_DAYS from `todayIso`. */
export function startTrial(todayIso: string, trialDays = TRIAL_DAYS): SubscriptionState {
  return { status: 'trial', currentPeriodEnd: addDays(todayIso, trialDays) };
}

/**
 * Extend the prepaid period by one month on a completed payment. Extends from the
 * later of {current period end, today} so paying early stacks, but paying after a
 * lapse does NOT retroactively credit the lapsed days. Always returns `active`
 * (a payment reactivates a past_due/suspended/trial subscription).
 */
export function renew(state: SubscriptionState, todayIso: string): SubscriptionState {
  if (state.status === 'cancelled') {
    throw new BillingError('cannot renew a cancelled subscription; start a new one');
  }
  const base = daysBetween(todayIso, state.currentPeriodEnd) > 0 ? state.currentPeriodEnd : todayIso;
  return { status: 'active', currentPeriodEnd: addMonth(base) };
}

/**
 * Compute the status the subscription SHOULD have as of `todayIso`, given its stored
 * status + period end. This is the single source of truth for transitions:
 *   - cancelled stays cancelled (terminal).
 *   - within the period → active (or stays trial if it was a trial).
 *   - period lapsed, within grace → past_due.
 *   - grace elapsed → suspended.
 * It NEVER moves backwards into active without a renewal (no silent reactivation).
 */
export function projectStatus(state: SubscriptionState, todayIso: string): SubscriptionStatus {
  if (state.status === 'cancelled') return 'cancelled';

  const daysLeft = daysBetween(todayIso, state.currentPeriodEnd); // >=0 means still covered
  if (daysLeft >= 0) {
    // Still inside the paid/trial window. Keep trial as trial; otherwise active.
    return state.status === 'trial' ? 'trial' : 'active';
  }
  // Period has lapsed (todayIso is past currentPeriodEnd).
  const daysOverdue = -daysLeft;
  return daysOverdue <= GRACE_DAYS ? 'past_due' : 'suspended';
}

/** True when the subscription grants full feature access as of today. */
export function hasAccess(state: SubscriptionState, todayIso: string): boolean {
  const s = projectStatus(state, todayIso);
  return s === 'trial' || s === 'active';
}

// ---------------------------------------------------------------- dunning

export type DunningStage = 'renewal_due_soon' | 'expired' | 'suspended';

export interface DunningDecision {
  /** The nudge to send now, or null if nothing is due. */
  stage: DunningStage | null;
  /** The status the subscription should be moved to (may equal current). */
  status: SubscriptionStatus;
  /** Stable key for the latch: which period-end this nudge is "for". */
  forPeriodEnd: string;
}

/**
 * Decide the dunning action for a subscription as of `todayIso`:
 *   - within RENEWAL_NUDGE_DAYS of period end (and still active/trial) → renewal_due_soon
 *   - just lapsed, within grace → expired (move to past_due, ask to renew)
 *   - grace elapsed → suspended (move to suspended, pay-to-reactivate)
 * Returns stage=null when nothing should be sent. The caller latches on
 * (stage, forPeriodEnd) so a daily pass sends each nudge at most once.
 */
export function dunningDecision(state: SubscriptionState, todayIso: string): DunningDecision {
  const status = projectStatus(state, todayIso);
  const daysLeft = daysBetween(todayIso, state.currentPeriodEnd);
  const base: Pick<DunningDecision, 'forPeriodEnd'> = { forPeriodEnd: state.currentPeriodEnd };

  if (status === 'cancelled' || status === 'suspended') {
    // suspended is itself a terminal dunning stage we announce once.
    if (status === 'suspended') return { stage: 'suspended', status, ...base };
    return { stage: null, status, ...base };
  }
  if (status === 'past_due') return { stage: 'expired', status, ...base };
  // active or trial: nudge only when the renewal window has opened.
  if (daysLeft >= 0 && daysLeft <= RENEWAL_NUDGE_DAYS) {
    return { stage: 'renewal_due_soon', status, ...base };
  }
  return { stage: null, status, ...base };
}
