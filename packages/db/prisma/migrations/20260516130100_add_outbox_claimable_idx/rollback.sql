-- =============================================================================
-- 20260516130100_add_outbox_claimable_idx — ROLLBACK
--
-- Operator-applied via psql. Prisma's migration runner does not invoke
-- rollback.sql automatically.
--
-- Usage:
--   psql "$DATABASE_URL" -f packages/db/prisma/migrations/20260516130100_add_outbox_claimable_idx/rollback.sql
--
-- Safe to run multiple times (IF EXISTS).
-- =============================================================================

DROP INDEX IF EXISTS "outbox_claimable_created_at";
