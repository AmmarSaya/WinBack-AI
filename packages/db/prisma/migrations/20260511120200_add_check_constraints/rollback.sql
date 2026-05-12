-- =============================================================================
-- 20260511120200_add_check_constraints — ROLLBACK
--
-- Operator-applied via psql. Safe to run multiple times.
-- =============================================================================

ALTER TABLE "MerchantSettings" DROP CONSTRAINT IF EXISTS "merchant_settings_ai_tone_shape";
ALTER TABLE "OutboxEvent"      DROP CONSTRAINT IF EXISTS "outbox_event_type_format";
