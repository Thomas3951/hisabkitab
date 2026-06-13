-- Phase 6: monthly VAT-return reminder scheduler.
-- reminder_log is the EXACTLY-ONCE latch: the scheduler may tick repeatedly (BullMQ
-- repeatable job + retries), but the unique (tenant_id, bs_year, bs_month, kind) row
-- guarantees a given reminder is sent at most once. Written by the orchestrator
-- (hisab_orch, cross-tenant by design — same as wa_events), never by the RLS app role.

CREATE TABLE reminder_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  bs_year     integer NOT NULL,
  bs_month    integer NOT NULL,
  -- which reminder this row represents:
  --   return_prepared : numbers prepared + self-verified, owner nudged to review
  --   vat_due_soon    : deadline nudge only (prep was held / not self-verified)
  kind        text NOT NULL CHECK (kind IN ('return_prepared', 'vat_due_soon')),
  -- self-verification verdict at send time (PRD §11): PASS | FAIL | BLOCKED
  verdict     text NOT NULL CHECK (verdict IN ('PASS', 'FAIL', 'BLOCKED')),
  net_payable_paisa bigint,
  is_nil      boolean,
  detail      text,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, bs_year, bs_month, kind)
);

CREATE INDEX reminder_log_tenant_idx ON reminder_log (tenant_id, bs_year, bs_month);

-- RLS: fail closed. Only the orchestrator role touches this table.
ALTER TABLE reminder_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_log FORCE ROW LEVEL SECURITY;

CREATE POLICY orch_all ON reminder_log TO hisab_orch USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON reminder_log TO hisab_orch;
