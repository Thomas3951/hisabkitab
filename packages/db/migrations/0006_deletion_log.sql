-- Phase 7 (hardening): proof a tenant data-deletion request was honored.
-- NO foreign key to tenants — the tenant row is deleted, but this record must
-- outlive it. Data-free: counts + ids only, never the deleted content. Written by
-- the orchestrator (hisab_orch), like wa_events / reminder_log.

CREATE TABLE deletion_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,          -- intentionally NOT a FK
  reason           text NOT NULL,
  rows_deleted     integer NOT NULL,
  sessions_deleted integer NOT NULL DEFAULT 0,
  detail           jsonb,
  deleted_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deletion_log_tenant_idx ON deletion_log (tenant_id);

ALTER TABLE deletion_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_log FORCE ROW LEVEL SECURITY;

CREATE POLICY orch_all ON deletion_log TO hisab_orch USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON deletion_log TO hisab_orch;

-- The deletion path DELETEs tenant rows as hisab_orch across every tenant table.
-- RLS fails closed, so orch needs an orch_all policy (USING true) on every table
-- it purges. Most got one in 0003/0005; vat_returns + vendors never did (nothing
-- cross-tenant touched them before). Add them (idempotent).
DROP POLICY IF EXISTS orch_all ON vat_returns;
CREATE POLICY orch_all ON vat_returns TO hisab_orch USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS orch_all ON vendors;
CREATE POLICY orch_all ON vendors TO hisab_orch USING (true) WITH CHECK (true);

-- DELETE grant on every RLS tenant table the purge removes (they had at most
-- SELECT/INSERT/UPDATE before).
GRANT SELECT, DELETE ON vat_returns, vendors TO hisab_orch;
GRANT DELETE ON sales, expenses, validation_events,
  audit_log, pairing_codes, payments, reminder_log, tenant_sessions, tenants TO hisab_orch;
