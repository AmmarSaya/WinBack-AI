-- =============================================================================
-- 20260511120300_add_backfill_job
--
-- Adds the BackfillJob table for resumable Shopify resource pulls (C5).
-- Pure-additive change — single new table + one new enum + one FK.
-- Auto-generatable by `prisma migrate dev --name add_backfill_job`; this
-- file is the hand-written equivalent. Verify locally with:
--
--   pnpm db:migrate:diff
--
-- Should report zero drift if applied against the v2.2 schema.
-- =============================================================================

-- CreateEnum
CREATE TYPE "BackfillStatus" AS ENUM ('pending', 'running', 'completed', 'paused', 'failed');

-- CreateTable
CREATE TABLE "BackfillJob" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "status" "BackfillStatus" NOT NULL DEFAULT 'pending',
    "cursor" TEXT,
    "pageSize" INTEGER NOT NULL DEFAULT 50,
    "itemsProcessed" INTEGER NOT NULL DEFAULT 0,
    "pagesProcessed" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackfillJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BackfillJob_merchantId_resource_key" ON "BackfillJob"("merchantId", "resource");

-- CreateIndex
CREATE INDEX "BackfillJob_status_idx" ON "BackfillJob"("status");

-- AddForeignKey
ALTER TABLE "BackfillJob" ADD CONSTRAINT "BackfillJob_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
