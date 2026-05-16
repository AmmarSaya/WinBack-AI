-- AlterTable
ALTER TABLE "OutboxEvent" ADD COLUMN     "deadLetteredAt" TIMESTAMP(3),
ADD COLUMN     "deferredFailedAt" TIMESTAMP(3);
