-- =============================================================================
-- 20260516130200_drop_outbox_unprocessed_idx — ROLLBACK
--
-- Operator-applied via psql. Prisma's migration runner does not invoke
-- rollback.sql automatically.
--
-- Recreates the original T2 partial index. This is a "panic button" to
-- restore pre-D4 query plans if the new claimable index proves
-- inadequate. Re-running is safe (IF NOT EXISTS).
--
-- Usage:
--   psql "$DATABASE_URL" -f packages/db/prisma/migrations/20260516130200_drop_outbox_unprocessed_idx/rollback.sql
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS "outbox_unprocessed_created_at"
  ON "OutboxEvent" ("createdAt")
  WHERE "processedAt" IS NULL;
