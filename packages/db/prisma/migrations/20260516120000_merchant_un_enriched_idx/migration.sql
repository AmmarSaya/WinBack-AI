-- @op-applied
-- This migration uses CREATE INDEX CONCURRENTLY and cannot run inside a
-- transaction. `prisma migrate deploy` will fail on this file. Operator
-- applies via psql, then marks resolved:
--
--   psql "$DATABASE_URL" -f packages/db/prisma/migrations/20260516120000_merchant_un_enriched_idx/migration.sql
--   pnpm --filter @winback/db prisma migrate resolve --applied 20260516120000_merchant_un_enriched_idx
--
-- =============================================================================
-- 20260516120000_merchant_un_enriched_idx
--
-- Partial index supporting the D3 enrichment-retry sweep query:
--
--   SELECT id, timezone FROM "Merchant"
--   WHERE "shopDetailsFetchedAt" IS NULL
--     AND "installedAt" < NOW() - INTERVAL '10 minutes'
--     AND "tokenRevokedAt" IS NULL
--     AND "uninstalledAt" IS NULL;
--
-- See packages/shopify/src/backfill/install-enrichment.ts:43-46 for the
-- query's design contract; see apps/scheduler/src/handlers/enrichment-
-- sweep.ts for the call site.
--
-- The partial predicate keeps the index bounded by un-enriched cardinality
-- (small at all times — eventually ~0 as enrichment catches up), not total
-- merchant count. Index leads with installedAt so the `< NOW() - INTERVAL
-- '10 minutes'` range scan stays efficient.
--
-- Paired DOWN: rollback.sql (operator-applied; Prisma does not auto-revert).
-- =============================================================================

CREATE INDEX CONCURRENTLY "Merchant_un_enriched_idx"
  ON "Merchant" ("installedAt")
  WHERE "shopDetailsFetchedAt" IS NULL
    AND "tokenRevokedAt" IS NULL
    AND "uninstalledAt" IS NULL;
