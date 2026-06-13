-- Phase 6: the reminder scheduler runs as hisab_orch (cross-tenant, like the
-- WhatsApp webhook and the Khalti callback) and must READ tenant data to
-- independently self-verify a return (PRD §11): confirmed expenses' input VAT
-- and each entry's latest validation verdict.
--
-- Migration 0003 already gave hisab_orch an orch_all policy + grant on `sales`
-- (for the gateway-sale callback). `expenses` and `validation_events` were never
-- granted to orch because nothing cross-tenant read them until now. Mirror the
-- 0003 pattern here. Read-only (SELECT) — the scheduler never writes these.
-- Idempotent (drop-if-exists) so a partial/re-run is safe.

-- expenses: orch needs to sum confirmed input VAT for the month.
DROP POLICY IF EXISTS orch_all ON expenses;
CREATE POLICY orch_all ON expenses TO hisab_orch USING (true) WITH CHECK (true);
GRANT SELECT ON expenses TO hisab_orch;

-- validation_events: orch needs each entry's latest verdict to detect an
-- unresolved `fail` in the period.
DROP POLICY IF EXISTS orch_all ON validation_events;
CREATE POLICY orch_all ON validation_events TO hisab_orch USING (true) WITH CHECK (true);
GRANT SELECT ON validation_events TO hisab_orch;
