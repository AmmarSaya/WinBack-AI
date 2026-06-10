-- A4 (POST-EPIC-F §4.2) — winback discount lifecycle columns.
--
-- MerchantSettings gains the per-merchant discount policy:
--   · winbackDiscountEnabled (Boolean, DEFAULT false) — SAFE-BY-DEFAULT
--     on/off. Discounting is a separate opt-in from re-engagement messaging;
--     a merchant must turn it on before any code is minted.
--   · winbackDiscountPercent (Int, DEFAULT 15) — how much, snapshotted onto
--     each AiGeneration at enqueue so later settings changes never rewrite a
--     message that already shipped.
--
-- AiGeneration gains the minted-discount snapshot (all NULLABLE):
--   · discountValuePercent (Int?) — set at ENQUEUE; doubles as the intent
--     flag (non-null ⇒ the stored prompt emitted the V9 placeholder tokens).
--   · discountCode (String?)      — set by the AI Worker after minting.
--   · shopifyDiscountId (String?) — set by the AI Worker after minting; the
--     handle the deferred 4.3 cleanup cron will delete by.
--
-- Additive only. The MerchantSettings columns are NOT NULL with DEFAULTs on a
-- 1-row-per-merchant table (single-digit live rows in prod) — metadata-only
-- ADD COLUMN on PG11+, no table rewrite, brief ACCESS EXCLUSIVE lock per ALTER.
-- The AiGeneration columns are nullable (no DEFAULT) — also metadata-only.
--
-- Sequence B: applied to production via `pnpm db:migrate:deploy` AFTER this PR
-- merges to main — never before, never via the Neon MCP. See
-- POST-EPIC-F-CONSCIOUS-DECISION.md §4 + packages/db/MIGRATIONS.md.

-- AlterTable
ALTER TABLE "MerchantSettings" ADD COLUMN     "winbackDiscountEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "winbackDiscountPercent" INTEGER NOT NULL DEFAULT 15;

-- AlterTable
ALTER TABLE "AiGeneration" ADD COLUMN     "discountCode" TEXT,
ADD COLUMN     "discountValuePercent" INTEGER,
ADD COLUMN     "shopifyDiscountId" TEXT;
