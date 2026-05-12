-- =============================================================================
-- 20260511120200_add_check_constraints
--
-- Implements: T4, T5 (see schema.prisma header).
--
-- Separated from functional-indexes migration because failure modes differ:
-- CHECK constraints fail when existing data violates the predicate. On a
-- fresh init this is impossible; on later schema changes, validate against
-- production data BEFORE deploying (see MIGRATIONS.md, "Adding constraints
-- to populated tables").
--
-- Paired DOWN: rollback.sql.
-- =============================================================================

-- T4: OutboxEvent.type format. Combined with the TS-typed event-name
-- registry in @winback/contracts, this is defense in depth — the DB rejects
-- typos at the SQL boundary, the registry rejects them at the TS boundary.
-- Pattern matches "<domain>.<event>" with optional "@v<n>" suffix:
--   "order.placed"
--   "customer.updated"
--   "campaign.send_completed@v2"
ALTER TABLE "OutboxEvent"
  ADD CONSTRAINT "outbox_event_type_format"
  CHECK (type ~ '^[a-z][a-z_]*\.[a-z][a-z_0-9]*(@v[0-9]+)?$');

-- T5: structural floor for MerchantSettings.aiTone (Json column). DB rejects
-- non-object Json. Detailed shape validation (enum values for `style`,
-- string-length bounds, etc.) lives in @winback/contracts' AiTone zod
-- schema, enforced by the typed repository chokepoint in B3.
--
-- Two-layer defense: DB owns the floor; the application owns the shape.
ALTER TABLE "MerchantSettings"
  ADD CONSTRAINT "merchant_settings_ai_tone_shape"
  CHECK ("aiTone" IS NULL OR jsonb_typeof("aiTone") = 'object');
