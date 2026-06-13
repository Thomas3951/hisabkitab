/**
 * Monthly VAT-return reminder (PRD v1.0 §16 Phase 5 step 8 / v1.1 Phase 6).
 *
 * For the BS month that just ENDED, for each active VAT-registered tenant:
 *   1. generate_return_summary (deterministic ledger tool — no agent, no API spend)
 *   2. self-verify the figures INDEPENDENTLY (PRD §11) — recompute, must agree
 *   3. choose the proactive Utility template:
 *        PASS → return_prepared  ("…ready: net payable Rs X. Reply 'show'.")
 *        not-PASS → vat_due_soon (figure-FREE deadline nudge; numbers are HELD,
 *                   flagged for review — never state an unverified figure)
 *   4. send via WaClient.sendTemplate (the only legal proactive send), and
 *   5. record reminder_log (exactly-once: the unique (tenant,year,month,kind)
 *      means a repeated/retried tick re-sends NOTHING).
 *
 * Consent is untouched: a reminder only PREPARES + nudges. The owner still must
 * reply and give an explicit "✅" before mark_return_filed_by_user. Self-verify
 * reduces error; it never files or moves money.
 */
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@hisab/db';
import {
  adToBs,
  BS_MONTH_NAMES,
  formatNpr,
  vatFilingDeadline,
  type BsDate,
} from '@hisab/shared';
import { selfVerifyReturn, type SelfVerifyResult } from './self-verify.js';

const { tenants, reminderLog } = schema;

/** The deterministic ledger tool, injected so tests use the in-memory server and
 *  production calls the real Ledger MCP over HTTP with a signed tenant token. */
export type ReturnSummaryProvider = (
  tenantId: string,
  bsYear: number,
  bsMonth: number,
) => Promise<{ netPayablePaisa: bigint; isNil: boolean; filingDeadlineAd: string }>;

/** Send a pre-approved Utility template to a tenant's WhatsApp number. */
export type TemplateSender = (
  toE164: string,
  templateName: 'return_prepared' | 'vat_due_soon',
  bodyParams: string[],
) => Promise<void>;

export interface ReminderJobDeps {
  /** hisab_orch handle (cross-tenant; queries carry explicit tenant filters). */
  db: Db;
  getReturnSummary: ReturnSummaryProvider;
  sendTemplate: TemplateSender;
  log?: (msg: string) => void;
}

export interface TenantReminderOutcome {
  tenantId: string;
  status: 'sent' | 'already_sent' | 'skipped' | 'error';
  kind?: 'return_prepared' | 'vat_due_soon';
  verdict?: SelfVerifyResult['verdict'];
  detail: string;
}

/** Human BS month label, e.g. "Shrawan 2082". */
export function bsMonthLabel(year: number, month: number): string {
  return `${BS_MONTH_NAMES[month - 1] ?? `M${month}`} ${year}`;
}

/** The BS month immediately before the given BS date (handles year rollover). */
export function previousBsMonth(bs: BsDate): { bsYear: number; bsMonth: number } {
  return bs.month === 1
    ? { bsYear: bs.year - 1, bsMonth: 12 }
    : { bsYear: bs.year, bsMonth: bs.month - 1 };
}

const ddMon = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/**
 * Process ONE tenant for one BS return month. Exactly-once: a successful send
 * inserts the reminder_log row; a duplicate insert (the unique key) means it was
 * already sent and we send nothing again.
 */
export async function remindTenant(
  deps: ReminderJobDeps,
  tenant: { id: string; whatsappE164: string },
  bsYear: number,
  bsMonth: number,
): Promise<TenantReminderOutcome> {
  const label = bsMonthLabel(bsYear, bsMonth);
  try {
    const summary = await deps.getReturnSummary(tenant.id, bsYear, bsMonth);
    const verify = await selfVerifyReturn(deps.db, tenant.id, bsYear, bsMonth, {
      netPayablePaisa: summary.netPayablePaisa,
      isNil: summary.isNil,
    });

    // PASS → state the numbers; not-PASS → HOLD numbers, send the figure-free nudge.
    const kind: 'return_prepared' | 'vat_due_soon' =
      verify.verdict === 'PASS' ? 'return_prepared' : 'vat_due_soon';
    // self-verify only emits PASS/FAIL/BLOCKED; SKIP shouldn't occur, but "when in
    // doubt do not pass" → store it as BLOCKED (held), never a false PASS.
    const verdict: 'PASS' | 'FAIL' | 'BLOCKED' = verify.verdict === 'SKIP' ? 'BLOCKED' : verify.verdict;

    // Exactly-once latch FIRST: claim the (tenant,year,month,kind) slot. If the row
    // already exists, this tick already sent it — do not re-send.
    const claimed = await deps.db
      .insert(reminderLog)
      .values({
        tenantId: tenant.id,
        bsYear,
        bsMonth,
        kind,
        verdict,
        netPayablePaisa: kind === 'return_prepared' ? summary.netPayablePaisa : null,
        isNil: verify.recomputed.isNil,
        detail: verify.detail,
      })
      .onConflictDoNothing()
      .returning({ id: reminderLog.id });

    if (claimed.length === 0) {
      return { tenantId: tenant.id, status: 'already_sent', kind, verdict: verify.verdict, detail: `${label}: already sent` };
    }

    const deadline = ddMon(summary.filingDeadlineAd);
    try {
      if (kind === 'return_prepared') {
        await deps.sendTemplate(tenant.whatsappE164, 'return_prepared', [label, formatNpr(summary.netPayablePaisa).replace('Rs ', '')]);
      } else {
        await deps.sendTemplate(tenant.whatsappE164, 'vat_due_soon', [label, deadline]);
      }
    } catch (sendErr) {
      // The slot is claimed but the send failed — roll the latch back so a later
      // tick can retry (the whole point of exactly-once is "sent", not "attempted").
      await deps.db.delete(reminderLog).where(eq(reminderLog.id, claimed[0]!.id));
      throw sendErr;
    }

    deps.log?.(`reminder ${kind} → ${tenant.id} (${label}, ${verify.verdict}): ${verify.detail}`);
    return { tenantId: tenant.id, status: 'sent', kind, verdict: verify.verdict, detail: `${label}: ${verify.verdict} → ${kind}` };
  } catch (err) {
    deps.log?.(`reminder FAILED for ${tenant.id} (${label}): ${String(err)}`);
    return { tenantId: tenant.id, status: 'error', detail: `${label}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Run the reminder pass for every active VAT-registered tenant with a bound
 * WhatsApp number, for the BS month that just ended relative to `now`.
 */
export async function runReminderPass(
  deps: ReminderJobDeps,
  now: Date = new Date(),
): Promise<TenantReminderOutcome[]> {
  const { bsYear, bsMonth } = previousBsMonth(adToBs(now));
  void vatFilingDeadline(bsYear, bsMonth); // assert the BS month is valid before we fan out

  const activeTenants = await deps.db
    .select({ id: tenants.id, whatsappE164: tenants.whatsappE164, vatRegistered: tenants.vatRegistered })
    .from(tenants)
    .where(eq(tenants.status, 'active'));

  const outcomes: TenantReminderOutcome[] = [];
  for (const t of activeTenants) {
    if (!t.vatRegistered) {
      outcomes.push({ tenantId: t.id, status: 'skipped', detail: 'not VAT-registered' });
      continue;
    }
    if (!t.whatsappE164) {
      outcomes.push({ tenantId: t.id, status: 'skipped', detail: 'no WhatsApp number bound' });
      continue;
    }
    outcomes.push(await remindTenant(deps, { id: t.id, whatsappE164: t.whatsappE164 }, bsYear, bsMonth));
  }
  return outcomes;
}
