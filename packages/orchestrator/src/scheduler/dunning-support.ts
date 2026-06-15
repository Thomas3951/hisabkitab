/**
 * Thin re-exports for the dunning job. Plan name/price come from @hisab/shared
 * PLAN_META (the single source of truth), so the orchestrator never depends on the
 * payments package just to render a renewal nudge.
 */
import { planName, planPricePaisa, type DunningStage } from '@hisab/shared';

export { dunningDecision, type DunningStage, type SubscriptionStatus } from '@hisab/shared';

export function getPlanName(code: string): string {
  return planName(code);
}

/** Rupee display for a plan's monthly price, e.g. "4,999". */
export function planPriceDisplay(code: string): string {
  return (planPricePaisa(code) / 100).toLocaleString('en-IN');
}

export type { DunningStage as Stage };
