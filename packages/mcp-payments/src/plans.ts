/**
 * Subscription plans (v2.0 P10 billing) — the SMB pays HisabKitab.
 *
 * SINGLE SOURCE OF TRUTH for the three tiers. Prices are integer paisa (CLAUDE.md
 * §3: money is paisa, never floats). The landing /pay page mirrors these numbers.
 *
 * Nepali gateways have no card-on-file auto-debit, so a subscription is modelled
 * as a PREPAID PERIOD: the owner pays for one month up front (PRD v2.0 §2). No
 * silent recurring charge.
 */

export type PlanCode = 'starter' | 'pro' | 'business';

export interface Plan {
  code: PlanCode;
  name: string;
  /** Monthly price in integer paisa (1 NPR = 100 paisa). */
  pricePaisa: number;
  blurb: string;
  features: string[];
}

/** Ordered cheapest → priciest; the order the agent and the page present them. */
export const SUBSCRIPTION_PLANS: readonly Plan[] = [
  {
    code: 'starter',
    name: 'Starter',
    pricePaisa: 299_900, // Rs 2,999 / month
    blurb: 'For a solo shop finding its rhythm.',
    features: ['Log by photo or text', 'VAT reminders', 'Nil return prep', '1 user'],
  },
  {
    code: 'pro',
    name: 'Pro',
    pricePaisa: 499_900, // Rs 4,999 / month
    blurb: 'For a growing business with credit customers.',
    features: ['Everything in Starter', 'Debtors and creditors', 'Statements and aging', '3 users'],
  },
  {
    code: 'business',
    name: 'Business',
    pricePaisa: 799_900, // Rs 7,999 / month
    blurb: 'For an established SMB and its accountant.',
    features: ['Everything in Pro', 'All PDF reports', 'Accountant seat', 'Priority support'],
  },
] as const;

const BY_CODE = new Map<string, Plan>(SUBSCRIPTION_PLANS.map((p) => [p.code, p]));

/** Look up a plan by code; undefined for an unknown code (caller rejects). */
export function getPlan(code: string): Plan | undefined {
  return BY_CODE.get(code);
}

/** Rupee string for display/audit, derived from paisa (never the other way). */
export function rupees(pricePaisa: number): string {
  return `Rs ${(pricePaisa / 100).toLocaleString('en-IN')}`;
}
