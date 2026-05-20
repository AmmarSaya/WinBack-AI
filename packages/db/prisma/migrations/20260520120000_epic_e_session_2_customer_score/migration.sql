-- Epic E session 2 — CustomerScore table + insufficient_data enum value.
-- See EPIC-E-SESSION-2-DESIGN.md for the full contract; §S-4/§S-5 for the
-- enum value, §CustomerScore-table-schema for the columns + indexes.
--
-- Additive migration:
--   1. ADD VALUE 'insufficient_data' to existing CustomerState enum.
--      Non-breaking; existing rows keep their values (default 'active').
--      PG 12+ allows ADD VALUE inside the migration tx — the new value
--      isn't used elsewhere in this migration so the single-tx
--      restriction doesn't bite.
--   2. CREATE TABLE "CustomerScore" with three indexes and two CASCADE
--      FKs (Merchant + Customer). No backfill — the scoring service in
--      later batches populates the rows on first webhook arrival.
--
-- No CONCURRENTLY needed (new table; no existing rows to lock).

-- AlterEnum
ALTER TYPE "CustomerState" ADD VALUE 'insufficient_data';

-- CreateTable
CREATE TABLE "CustomerScore" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "rDays" INTEGER NOT NULL,
    "fCount" INTEGER NOT NULL,
    "mCents" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "rQuintile" INTEGER,
    "fQuintile" INTEGER,
    "mQuintile" INTEGER,
    "churnRiskScore" DOUBLE PRECISION,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerScore_customerId_key" ON "CustomerScore"("customerId");

-- CreateIndex
CREATE INDEX "CustomerScore_merchantId_churnRiskScore_idx" ON "CustomerScore"("merchantId", "churnRiskScore" DESC);

-- CreateIndex
CREATE INDEX "CustomerScore_merchantId_computedAt_idx" ON "CustomerScore"("merchantId", "computedAt");

-- AddForeignKey
ALTER TABLE "CustomerScore" ADD CONSTRAINT "CustomerScore_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerScore" ADD CONSTRAINT "CustomerScore_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
