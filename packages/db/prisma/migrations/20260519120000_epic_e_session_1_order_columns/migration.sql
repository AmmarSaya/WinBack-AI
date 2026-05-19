-- Epic E session 1 — additive Order columns for data-writer landings.
-- See EPIC-E-FIELD-MAPPING.md rows #6 (shopifyProcessedAt) and #81 (isTest).
--
-- Both columns are additive and non-breaking — existing rows acquire null /
-- false defaults. No CONCURRENTLY needed (column adds on a young table; no
-- live merchants to consider for lock contention).

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shopifyProcessedAt" TIMESTAMP(3);
