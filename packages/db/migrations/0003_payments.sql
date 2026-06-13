-- Phase 5: Payments (PRD v1.1 §10) — Khalti v2 live; eSewa/Fonepay "coming soon".
--
-- One row per initiated payment. `pidx` (Khalti's payment id) is UNIQUE — the
-- callback/verify path upserts against it, so a replayed callback or a double
-- verify can NEVER complete a payment twice (exactly-once, CLAUDE.md §3).
-- A completed payment creates ONE confirmed gateway sale (sale_id set in the
-- same transaction — its presence is the idempotency latch for sale creation).

CREATE TABLE payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  provider            TEXT NOT NULL DEFAULT 'khalti',
  pidx                TEXT NOT NULL UNIQUE,
  purchase_order_id   TEXT NOT NULL,
  purchase_order_name TEXT NOT NULL,
  amount_paisa        BIGINT NOT NULL CHECK (amount_paisa > 0),
  status              TEXT NOT NULL DEFAULT 'initiated',
                      -- initiated | completed | canceled | expired | refunded | amount_mismatch
  transaction_id      TEXT,
  fee_paisa           BIGINT NOT NULL DEFAULT 0,
  sale_id             UUID REFERENCES sales(id),
  payment_url         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX payments_tenant_created_idx ON payments (tenant_id, created_at);

-- RLS: tenant-scoped for the MCP runtime (hisab_app)…
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payments
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON payments TO hisab_app;

-- …and cross-tenant for the callback path (the return-URL redirect is
-- unauthenticated; the row is located by pidx, so the handler runs as
-- hisab_orch — the same trust root that mints tenant tokens).
CREATE POLICY orch_all ON payments TO hisab_orch USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON payments TO hisab_orch;

-- The callback also records the confirmed gateway sale + validation trail.
CREATE POLICY orch_all ON sales             TO hisab_orch USING (true) WITH CHECK (true);
CREATE POLICY orch_all ON validation_events TO hisab_orch USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON sales             TO hisab_orch;
GRANT SELECT, INSERT         ON validation_events TO hisab_orch;
