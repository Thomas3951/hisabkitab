/** Test connection URLs (override via env; defaults match manual.txt local setup). */
export const ADMIN_URL =
  process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/hisabkitab_test';
/** Orchestrator connects as hisab_orch (cross-tenant webhook role from migration 0002). */
export const ORCH_URL =
  process.env['TEST_ORCH_DATABASE_URL'] ??
  'postgres://hisab_orch:hisab_orch_dev@localhost:5432/hisabkitab_test';
