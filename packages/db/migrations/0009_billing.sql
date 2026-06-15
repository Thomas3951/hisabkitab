-- P10 billing lifecycle (PRD v2.0 §2, §15): the SMB pays HisabKitab.
--
-- A subscription is a PREPAID PERIOD (no card-on-file auto-debit in Nepal). The
-- owner pays for a month up front; a completed Khalti payment EXTENDS the period.
-- Lifecycle: trial -> active -> past_due (grace) -> suspended -> cancelled.
--
-- Two tables, mirroring the 0003 payments pattern:
--   subscriptions   one per tenant (the lifecycle state + current period end)
--   billing_payments the tenant paying US (separate from `payments`, which is the
--                    business collecting from ITS customers and creates a sale).
-- Plan prices are config in code (packages/mcp-payments/src/plans.ts), not a table,
-- so plan_code is a free TEXT validated in the tool (no plans table to keep in sync).

CREATE TABLE subscriptions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL UNIQUE REFERENCES tenants(id),   -- one sub per tenant
  plan_code          TEXT NOT NULL,                                 -- starter|pro|business
  status             TEXT NOT NULL DEFAULT 'trial'
                     CHECK (status IN ('trial', 'active', 'past_due', 'suspended', 'cancelled')),
  current_period_end DATE NOT NULL,
  -- dunning latch: the last (status, period_end) we sent a nudge for, so a daily
  -- pass never double-sends. NULL until the first nudge.
  last_dunned_stage  TEXT,
  last_dunned_for    DATE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE billing_payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  plan_code           TEXT NOT NULL,
  gateway             TEXT NOT NULL DEFAULT 'khalti',
  pidx                TEXT NOT NULL UNIQUE,        -- Khalti payment id: exactly-once latch
  purchase_order_id   TEXT NOT NULL,
  amount_paisa        BIGINT NOT NULL CHECK (amount_paisa > 0),
  status              TEXT NOT NULL DEFAULT 'initiated'
                      CHECK (status IN ('initiated', 'completed', 'canceled', 'expired', 'refunded', 'amount_mismatch')),
  transaction_id      TEXT,
  -- the prepaid period this payment bought (set when it completes)
  period_start        DATE,
  period_end          DATE,
  payment_url         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX subscriptions_status_period_idx ON subscriptions (status, current_period_end);
CREATE INDEX billing_payments_tenant_idx     ON billing_payments (tenant_id, created_at);

-- ---------------------------------------------------------------- Row-Level Security
ALTER TABLE subscriptions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_payments ENABLE ROW LEVEL SECURITY;

-- Tenant-scoped for the MCP runtime (hisab_app)…
CREATE POLICY tenant_isolation ON subscriptions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON billing_payments
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- …and cross-tenant (hisab_orch) for the unauthenticated Khalti return-URL callback
-- (settles by pidx) and the dunning pass (scans all tenants), mirroring 0003.
CREATE POLICY orch_all ON subscriptions    TO hisab_orch USING (true) WITH CHECK (true);
CREATE POLICY orch_all ON billing_payments TO hisab_orch USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- least-privilege grants
GRANT SELECT, INSERT, UPDATE ON subscriptions    TO hisab_app;
GRANT SELECT, INSERT, UPDATE ON billing_payments TO hisab_app;
GRANT SELECT, INSERT, UPDATE ON subscriptions    TO hisab_orch;
GRANT SELECT, INSERT, UPDATE ON billing_payments TO hisab_orch;
