-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('email');

-- CreateEnum
CREATE TYPE "EmailMarketingConsentState" AS ENUM ('subscribed', 'not_subscribed', 'pending', 'unsubscribed');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'active', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "CampaignTargetStatus" AS ENUM ('pending', 'sent', 'suppressed', 'deferred', 'failed');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('unsubscribe', 'bounce', 'complaint', 'manual');

-- CreateEnum
CREATE TYPE "MessageEventType" AS ENUM ('sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'unsubscribed', 'failed');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MessageStatus" ADD VALUE 'sent';
ALTER TYPE "MessageStatus" ADD VALUE 'suppressed';
ALTER TYPE "MessageStatus" ADD VALUE 'failed';
ALTER TYPE "MessageStatus" ADD VALUE 'bounced';
ALTER TYPE "MessageStatus" ADD VALUE 'opened';
ALTER TYPE "MessageStatus" ADD VALUE 'clicked';

-- AlterTable
ALTER TABLE "MerchantSettings" ADD COLUMN     "dailySendCap" INTEGER NOT NULL DEFAULT 2000,
ALTER COLUMN "monthlySendsCap" SET DEFAULT 50000;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "emailMarketingConsentState" "EmailMarketingConsentState" NOT NULL DEFAULT 'not_subscribed';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "campaignId" TEXT,
ADD COLUMN     "channel" "MessageChannel",
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "sentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'draft',
    "channel" "MessageChannel" NOT NULL DEFAULT 'email',
    "triggerStates" TEXT[],
    "marketingActivityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignTarget" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "CampaignTargetStatus" NOT NULL DEFAULT 'pending',
    "suppressedByGate" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageEvent" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "type" "MessageEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "providerEventId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageQuotaBucket" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageQuotaBucket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campaign_merchantId_status_idx" ON "Campaign"("merchantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignTarget_messageId_key" ON "CampaignTarget"("messageId");

-- CreateIndex
CREATE INDEX "CampaignTarget_merchantId_status_idx" ON "CampaignTarget"("merchantId", "status");

-- CreateIndex
CREATE INDEX "CampaignTarget_campaignId_status_idx" ON "CampaignTarget"("campaignId", "status");

-- CreateIndex
CREATE INDEX "Suppression_merchantId_channel_idx" ON "Suppression"("merchantId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "Suppression_merchantId_customerId_channel_key" ON "Suppression"("merchantId", "customerId", "channel");

-- CreateIndex
CREATE INDEX "MessageEvent_merchantId_messageId_idx" ON "MessageEvent"("merchantId", "messageId");

-- CreateIndex
CREATE INDEX "MessageEvent_merchantId_type_occurredAt_idx" ON "MessageEvent"("merchantId", "type", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessageEvent_merchantId_providerEventId_key" ON "MessageEvent"("merchantId", "providerEventId");

-- CreateIndex
CREATE INDEX "MessageQuotaBucket_merchantId_date_idx" ON "MessageQuotaBucket"("merchantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "MessageQuotaBucket_merchantId_date_key" ON "MessageQuotaBucket"("merchantId", "date");

-- CreateIndex
CREATE INDEX "Customer_merchantId_emailMarketingConsentState_idx" ON "Customer"("merchantId", "emailMarketingConsentState");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTarget" ADD CONSTRAINT "CampaignTarget_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTarget" ADD CONSTRAINT "CampaignTarget_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTarget" ADD CONSTRAINT "CampaignTarget_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignTarget" ADD CONSTRAINT "CampaignTarget_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Suppression" ADD CONSTRAINT "Suppression_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Suppression" ADD CONSTRAINT "Suppression_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageEvent" ADD CONSTRAINT "MessageEvent_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageEvent" ADD CONSTRAINT "MessageEvent_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageQuotaBucket" ADD CONSTRAINT "MessageQuotaBucket_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Epic G safety-ceiling reframe (G-Q9): raise existing rows still on the OLD
-- monthlySendsCap default (1000) to the new default (50000). GUARDED WHERE = 1000
-- so it ONLY touches rows at the un-chosen old default, never a deliberate value.
UPDATE "MerchantSettings" SET "monthlySendsCap" = 50000 WHERE "monthlySendsCap" = 1000;
