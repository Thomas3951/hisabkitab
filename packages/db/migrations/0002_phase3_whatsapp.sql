-- Phase 3: WhatsApp webhook infrastructure (PRD v1.0 §12–13).
--
-- The orchestrator is the trust root for tenancy (it mints the signed tenant
-- tokens), so it gets its own role `hisab_orch` with the cross-tenant access the
-- webhook needs (sender→tenant lookup, pairing, dedupe, session registry) —
-- while `hisab_app` (the MCP runtime) stays strictly tenant-scoped via RLS.

-- Role is cluster-wide: guard so the migration also applies on hisabkitab_test.
-- Dev password — rotate for any real deployment (see manual.txt).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hisab_orch') THEN
    CREATE ROLE hisab_orch LOGIN PASSWORD 'hisab_orch_dev' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

-- Inbound WhatsApp idempotency: Meta retries webhooks; an entry is NEVER
-- processed twice. Insert-or-conflict on the Meta message id is the gate.
CREATE TABLE wa_events (
  wa_message_id TEXT PRIMARY KEY,
  from_e164     TEXT NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One persistent Managed Agents session per tenant (one session = one tenant).
CREATE TABLE tenant_sessions (
  tenant_id  UUID PRIMARY KEY REFERENCES tenants(id),
  session_id TEXT NOT NULL,
  vault_id   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX wa_events_received_idx ON wa_events (received_at);

-- ------------------------------------------------------------------ RLS
-- Orchestrator-only tables: RLS on, with an explicit allow-all policy scoped TO
-- hisab_orch. hisab_app gets no grants and no policy → no access (fails closed).
ALTER TABLE wa_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY orch_all ON wa_events       TO hisab_orch USING (true) WITH CHECK (true);
CREATE POLICY orch_all ON tenant_sessions TO hisab_orch USING (true) WITH CHECK (true);

-- Orchestrator cross-tenant policies on existing tables (webhook path only):
--   tenants:       sender→tenant lookup, pairing bind (whatsapp_e164, status)
--   pairing_codes: code lookup + consume
--   audit_log:     pairing + gate decisions
CREATE POLICY orch_all ON tenants       TO hisab_orch USING (true) WITH CHECK (true);
CREATE POLICY orch_all ON pairing_codes TO hisab_orch USING (true) WITH CHECK (true);
CREATE POLICY orch_all ON audit_log     TO hisab_orch USING (true) WITH CHECK (true);

-- ------------------------------------------------------------------ grants
GRANT USAGE ON SCHEMA public TO hisab_orch;
GRANT SELECT, INSERT, UPDATE ON tenants         TO hisab_orch;
GRANT SELECT, INSERT, UPDATE ON pairing_codes   TO hisab_orch;
GRANT SELECT, INSERT         ON audit_log       TO hisab_orch;
GRANT SELECT, INSERT         ON wa_events       TO hisab_orch;
GRANT SELECT, INSERT, UPDATE ON tenant_sessions TO hisab_orch;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hisab_orch;
