-- =============================================================================
-- 20260511120100_add_functional_indexes — ROLLBACK
--
-- Operator-applied via psql. Prisma's migration runner does not invoke
-- rollback.sql automatically.
--
-- Usage:
--   psql "$DATABASE_URL" -f packages/db/prisma/migrations/20260511120100_add_functional_indexes/rollback.sql
--
-- Safe to run multiple times (IF EXISTS).
-- =============================================================================

DROP INDEX IF EXISTS "customer_tags_gin";
DROP INDEX IF EXISTS "outbox_unprocessed_created_at";
DROP INDEX IF EXISTS "customer_merchant_email_lower";
