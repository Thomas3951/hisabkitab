/**
 * Session-outcome self-verification (PRD v1.0 §11 / v1.1 §11).
 *
 * Before any return figure is presented or a reminder states numbers, an
 * INDEPENDENT recomputation must agree with the prepared return. This module
 * re-derives the invariant from the confirmed ledger rows directly — it does
 * NOT trust generate_return_summary's output; it checks it:
 *
 *   net_payable == max( Σ confirmed sales.vat − Σ confirmed expenses.input_vat, 0 )
 *   AND is_nil  == (confirmed sale_count == 0 AND confirmed expense_count == 0)
 *   AND no entry in this BS month has an unresolved `fail` validation
 *
 * Verdict (CLAUDE.md §8 taxonomy):
 *   PASS    — independent recompute agrees → safe to present / nudge with numbers
 *   FAIL    — recompute disagrees, or an unresolved `fail` exists → HOLD, do not
 *             state numbers; send the figure-free deadline nudge and flag for review
 *   BLOCKED — couldn't observe (db/query error) → treat as not-PASS (hold + ask)
 *
 * Runs on the orchestrator's hisab_orch handle (cross-tenant; queries always
 * carry an explicit tenant_id filter — the scheduler is per-tenant by design).
 */
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { schema, type Db } from '@hisab/db';
import { bsMonthRange, netVatPosition } from '@hisab/shared';
import type { Verdict } from '@hisab/shared';

const { sales, expenses, validationEvents } = schema;

/** The prepared figures we are checking (from generate_return_summary). */
export interface PreparedReturn {
  netPayablePaisa: bigint;
  isNil: boolean;
}

export interface SelfVerifyResult {
  verdict: Verdict;
  detail: string;
  /** Independently recomputed, for logging/observability. */
  recomputed: {
    outputVatPaisa: bigint;
    inputVatPaisa: bigint;
    netPayablePaisa: bigint;
    saleCount: number;
    expenseCount: number;
    isNil: boolean;
    unresolvedFailCount: number;
  };
}

/**
 * LOCAL-parts ISO date — must match the Ledger MCP's monthRange formatting
 * (mcp-ledger/src/tools.ts toIso) EXACTLY. Using UTC (.toISOString()) here would
 * shift the month boundary by a day on non-UTC machines, so a sale on the first
 * day of a BS month would fall outside the recompute window while the ledger
 * counted it — a false self-verify FAIL. occurred_on is a calendar date; compare
 * it in the same calendar the ledger uses.
 */
const toIso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Aggregate one CONFIRMED table's VAT column for a BS month, by an explicit
 * tenant filter (orch role). Mirrors the ledger's confirmed-only aggregation,
 * but computed here independently as the cross-check.
 */
async function confirmedVat(
  db: Db,
  tenantId: string,
  table: typeof sales | typeof expenses,
  vatColumn: typeof sales.vatPaisa | typeof expenses.inputVatPaisa,
  fromIso: string,
  toIsoDate: string,
): Promise<{ vat: bigint; count: number }> {
  const [row] = await db
    .select({
      vat: sql<string>`coalesce(sum(${vatColumn}), 0)`,
      count: sql<number>`count(*)::int`,
    })
    .from(table)
    .where(
      and(
        eq(table.tenantId, tenantId),
        eq(table.status, 'confirmed'),
        gte(table.occurredOn, fromIso),
        lte(table.occurredOn, toIsoDate),
      ),
    );
  return { vat: BigInt(row?.vat ?? '0'), count: row?.count ?? 0 };
}

/** Count unresolved `fail` validation events for entries in this BS month. */
async function unresolvedFails(
  db: Db,
  tenantId: string,
  fromIso: string,
  toIsoDate: string,
): Promise<number> {
  // An entry has a "current" verdict = its latest validation_events row. A FAIL
  // is unresolved if the entry's most recent validation result is 'fail' AND the
  // entry still exists in the period as a sale/expense (drafts that were fixed get
  // a newer pass/warn row; deleted entries don't count). We check both tables.
  const failRows = await db
    .select({
      entryId: validationEvents.entryId,
      entryType: validationEvents.entryType,
      result: validationEvents.result,
      createdAt: validationEvents.createdAt,
    })
    .from(validationEvents)
    .where(eq(validationEvents.tenantId, tenantId))
    .orderBy(validationEvents.createdAt);

  // latest result per (entryType, entryId)
  const latest = new Map<string, string>();
  for (const r of failRows) {
    if (!r.entryId) continue;
    latest.set(`${r.entryType}:${r.entryId}`, r.result);
  }
  const failingIds = [...latest.entries()].filter(([, res]) => res === 'fail').map(([k]) => k);
  if (failingIds.length === 0) return 0;

  // keep only those whose entry actually falls in this BS month
  let count = 0;
  for (const key of failingIds) {
    const [type, id] = key.split(':');
    const table = type === 'sale' ? sales : type === 'expense' ? expenses : null;
    if (!table) continue;
    const [hit] = await db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.id, id!),
          eq(table.tenantId, tenantId),
          gte(table.occurredOn, fromIso),
          lte(table.occurredOn, toIsoDate),
        ),
      )
      .limit(1);
    if (hit) count += 1;
  }
  return count;
}

/**
 * Independently re-derive the return and compare against the prepared figures.
 * Any disagreement, or any unresolved fail, is a FAIL (hold — do not state numbers).
 */
export async function selfVerifyReturn(
  db: Db,
  tenantId: string,
  bsYear: number,
  bsMonth: number,
  prepared: PreparedReturn,
): Promise<SelfVerifyResult> {
  let recomputed: SelfVerifyResult['recomputed'];
  try {
    const { from, to } = bsMonthRange(bsYear, bsMonth);
    const fromIso = toIso(from);
    const toIsoDate = toIso(to);

    const [out, inp, unresolvedFailCount] = await Promise.all([
      confirmedVat(db, tenantId, sales, sales.vatPaisa, fromIso, toIsoDate),
      confirmedVat(db, tenantId, expenses, expenses.inputVatPaisa, fromIso, toIsoDate),
      unresolvedFails(db, tenantId, fromIso, toIsoDate),
    ]);
    const position = netVatPosition(out.vat, inp.vat);
    const isNil = out.count === 0 && inp.count === 0;
    recomputed = {
      outputVatPaisa: out.vat,
      inputVatPaisa: inp.vat,
      netPayablePaisa: position.netPayablePaisa,
      saleCount: out.count,
      expenseCount: inp.count,
      isNil,
      unresolvedFailCount,
    };
  } catch (err) {
    return {
      verdict: 'BLOCKED',
      detail: `could not recompute the return independently: ${err instanceof Error ? err.message : String(err)}`,
      recomputed: {
        outputVatPaisa: 0n,
        inputVatPaisa: 0n,
        netPayablePaisa: 0n,
        saleCount: 0,
        expenseCount: 0,
        isNil: false,
        unresolvedFailCount: -1,
      },
    };
  }

  const problems: string[] = [];
  if (recomputed.netPayablePaisa !== prepared.netPayablePaisa) {
    problems.push(
      `net_payable mismatch: prepared ${prepared.netPayablePaisa} paisa vs recomputed ${recomputed.netPayablePaisa} paisa`,
    );
  }
  if (recomputed.isNil !== prepared.isNil) {
    problems.push(`is_nil mismatch: prepared ${prepared.isNil} vs recomputed ${recomputed.isNil}`);
  }
  if (recomputed.unresolvedFailCount > 0) {
    problems.push(`${recomputed.unresolvedFailCount} entr${recomputed.unresolvedFailCount === 1 ? 'y has' : 'ies have'} an unresolved \`fail\` validation`);
  }

  if (problems.length > 0) {
    return { verdict: 'FAIL', detail: problems.join('; '), recomputed };
  }
  return {
    verdict: 'PASS',
    detail: `independent recompute agrees: net ${recomputed.netPayablePaisa} paisa, nil=${recomputed.isNil}, ${recomputed.saleCount} sales / ${recomputed.expenseCount} expenses, no unresolved fails`,
    recomputed,
  };
}
