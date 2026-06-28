-- Epic G batch 8.4 — SES send + tombstone state machine.
--
-- Three additive operations:
--   1. CampaignTargetStatus ADD VALUE 'sending'   (the tombstone state)
--   2. CampaignTarget.sendStartedAt               (operator observability)
--   3. Message.providerMessageId                  (SES MessageId; 8.5 SNS join key)
--
-- All three are additive; no backfill; existing rows untouched (NULL on the
-- two new columns; the enum value is unused by existing rows). The 8.1
-- MessageStatus pattern is followed for ALTER TYPE ADD VALUE — Postgres 12+
-- accepts it inside a transaction so long as the new value is not USED in
-- the same transaction (which is the case here — no UPDATE statement
-- references 'sending').

-- AlterEnum
ALTER TYPE "CampaignTargetStatus" ADD VALUE 'sending';

-- AlterTable
ALTER TABLE "CampaignTarget" ADD COLUMN     "sendStartedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "providerMessageId" TEXT;
