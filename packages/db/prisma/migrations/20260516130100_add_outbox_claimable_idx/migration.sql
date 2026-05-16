-- @op-applied
-- This migration uses CREATE INDEX CONCURRENTLY and cannot run inside a
-- transaction. `prisma migrate deploy` will fail on this file. Operator
-- applies via psql, then marks resolved:
--
--   psql "$DATABASE_URL" -f packages/db/prisma/migrations/20260516130100_add_outbox_claimable_idx/migration.sql
--   pnpm --filter @winback/db prisma migrate resolve --applied 20260516130100_add_outbox_claimable_idx
--
-- =============================================================================
-- 20260516130100_add_outbox_claimable_idx
--
-- D4 partial index supporting the updated `OutboxRepository.claimBatch`
-- predicate:
--
--   SELECT id, "merchantId", type, payload, "createdAt", attempts
--   FROM "OutboxEvent"
--   WHERE "processedAt" IS NULL AND "deadLetteredAt" IS NULL
--   ORDER BY "createdAt"
--   LIMIT $1
--   FOR UPDATE SKIP LOCKED
--
-- Supersedes the T2 index `outbox_unprocessed_created_at` which filtered
-- only on `processedAt IS NULL`. The new predicate adds `deadLetteredAt
-- IS NULL` so dead-lettered rows don't bloat the active claim path. The
-- old index is dropped in the paired migration
-- 20260516130200_drop_outbox_unprocessed_idx (separate folder per
-- MIGRATIONS.md "one CONCURRENTLY statement per file").
--
-- Deploy order matters: this CREATE runs BEFORE the DROP so claimBatch is
-- never indexless during the rollout window.
--
-- Paired DOWN: rollback.sql (operator-applied; Prisma does not auto-revert).
-- =============================================================================

CREATE INDEX CONCURRENTLY "outbox_claimable_created_at"
  ON "OutboxEvent" ("createdAt")
  WHERE "processedAt" IS NULL AND "deadLetteredAt" IS NULL;
