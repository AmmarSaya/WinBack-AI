-- =============================================================================
-- 20260511120100_add_functional_indexes
--
-- Implements: T1, T2, T3 (see schema.prisma header).
--
-- These indexes cannot be expressed in schema.prisma — they use functional
-- expressions, partial predicates, or non-btree types that Prisma's DSL
-- doesn't model. They are intentionally separated from check-constraint
-- migrations because the failure modes differ:
--   - Index creation can fail under concurrent load (mitigated by
--     CONCURRENTLY post-launch; init data is empty so plain CREATE is fine).
--   - Check constraints fail when existing data violates the predicate.
-- Rolling back independently is the reason for the split.
--
-- Paired DOWN: rollback.sql (operator-applied; Prisma does not auto-revert).
-- =============================================================================

-- T1: composite functional + partial index for case-insensitive email
-- lookup per merchant. Supports:
--   WHERE "merchantId" = $1 AND lower(email) = lower($2)
-- The partial predicate `WHERE "deletedAt" IS NULL` keeps the index small
-- and aligns with the Prisma Client Extension's auto-filter (B3).
CREATE INDEX "customer_merchant_email_lower"
  ON "Customer" ("merchantId", lower(email))
  WHERE "deletedAt" IS NULL;

-- T2: partial index optimizing the outbox drain query
--   SELECT id, type, payload FROM "OutboxEvent"
--   WHERE "processedAt" IS NULL ORDER BY "createdAt"
--   LIMIT N FOR UPDATE SKIP LOCKED;
-- Excludes processed rows so the index stays bounded by the unprocessed
-- backlog, not by all-time event volume.
CREATE INDEX "outbox_unprocessed_created_at"
  ON "OutboxEvent" ("createdAt")
  WHERE "processedAt" IS NULL;

-- T3: GIN index for tag membership queries on Customer.
--   WHERE tags @> ARRAY['vip']
--   WHERE tags && ARRAY['vip', 'champion']
-- Required for segmentation predicates over array-typed tags (Epic E).
CREATE INDEX "customer_tags_gin"
  ON "Customer" USING GIN (tags);
