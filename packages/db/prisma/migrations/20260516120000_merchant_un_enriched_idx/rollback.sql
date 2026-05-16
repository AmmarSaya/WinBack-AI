-- =============================================================================
-- 20260516120000_merchant_un_enriched_idx — ROLLBACK
--
-- Operator-applied via psql. Prisma's migration runner does not invoke
-- rollback.sql automatically.
--
-- Usage:
--   psql "$DATABASE_URL" -f packages/db/prisma/migrations/20260516120000_merchant_un_enriched_idx/rollback.sql
--
-- Safe to run multiple times (IF EXISTS).
-- =============================================================================

DROP INDEX IF EXISTS "Merchant_un_enriched_idx";
