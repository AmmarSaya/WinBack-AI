-- =============================================================================
-- 20260511120300_add_backfill_job — ROLLBACK
-- =============================================================================

ALTER TABLE IF EXISTS "BackfillJob" DROP CONSTRAINT IF EXISTS "BackfillJob_merchantId_fkey";
DROP TABLE IF EXISTS "BackfillJob";
DROP TYPE IF EXISTS "BackfillStatus";
