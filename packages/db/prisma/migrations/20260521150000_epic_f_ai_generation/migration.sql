-- Epic F batch 1 — AI generation pipeline tables + enums.
-- See EPIC-F-DESIGN.md for the full contract; §F-4 / §F-5 / §F-6 for the
-- three tables, §Schema-additions-summary for the cascade chain.
--
-- Additive migration. Three new tables, two new enums. Zero changes to
-- existing tables. No backfill — the AI Worker populates rows on first
-- `ai.generate` job after batch 4 ships.
--
-- Cascade chain (GDPR-critical link is the third):
--   Merchant → AiGeneration / Message / AiSpendBucket : CASCADE
--   Customer → AiGeneration / Message                 : CASCADE
--   AiGeneration → Message                            : CASCADE
--
-- Customer redact fires Customer→AiGeneration:CASCADE which transitively
-- removes the generation's Message via the AiGeneration→Message arrow.
-- The direct Customer→Message arrow is redundant defence — same atomic
-- DELETE statement.
--
-- Cost columns are BigInt MICROCENTS (1 USD = 100_000_000 microcents) —
-- modern LLM pricing is in fractions of a cent per token. See
-- EPIC-F-DESIGN.md §F-4 / §F-10 for the rate math.
--
-- No CONCURRENTLY needed (new tables; no existing rows to lock).

-- CreateEnum
CREATE TYPE "AiGenerationStatus" AS ENUM ('pending', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('draft');

-- CreateTable
CREATE TABLE "AiGeneration" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "triggerState" TEXT NOT NULL,
    "previousState" TEXT NOT NULL,
    "rDays" INTEGER NOT NULL,
    "fCount" INTEGER NOT NULL,
    "mCents" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "churnRiskScore" DOUBLE PRECISION,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "userPrompt" TEXT NOT NULL,
    "generatedText" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "latencyMs" INTEGER,
    "costMicrocents" BIGINT,
    "status" "AiGenerationStatus" NOT NULL DEFAULT 'pending',
    "failedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AiGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "aiGenerationId" TEXT NOT NULL,
    "generatedText" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiSpendBucket" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "spentMicrocents" BIGINT NOT NULL DEFAULT 0,
    "generationCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiSpendBucket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiGeneration_merchantId_createdAt_idx" ON "AiGeneration"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "AiGeneration_merchantId_customerId_idx" ON "AiGeneration"("merchantId", "customerId");

-- CreateIndex
CREATE INDEX "AiGeneration_status_createdAt_idx" ON "AiGeneration"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_aiGenerationId_key" ON "Message"("aiGenerationId");

-- CreateIndex
CREATE INDEX "Message_merchantId_status_idx" ON "Message"("merchantId", "status");

-- CreateIndex
CREATE INDEX "Message_merchantId_customerId_idx" ON "Message"("merchantId", "customerId");

-- CreateIndex
CREATE INDEX "Message_merchantId_createdAt_idx" ON "Message"("merchantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiSpendBucket_merchantId_date_key" ON "AiSpendBucket"("merchantId", "date");

-- CreateIndex
CREATE INDEX "AiSpendBucket_merchantId_date_idx" ON "AiSpendBucket"("merchantId", "date");

-- AddForeignKey
ALTER TABLE "AiGeneration" ADD CONSTRAINT "AiGeneration_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiGeneration" ADD CONSTRAINT "AiGeneration_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_aiGenerationId_fkey" FOREIGN KEY ("aiGenerationId") REFERENCES "AiGeneration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSpendBucket" ADD CONSTRAINT "AiSpendBucket_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
