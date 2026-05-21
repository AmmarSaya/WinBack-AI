-- S-4 hardening — replace the two-column OrderLineItem unique constraint
-- with a tenant-prefixed three-column variant.
--
-- Why: every other tenant-scoped model in this schema uses
-- @@unique([merchantId, shopifyXxxId]).  OrderLineItem's original
-- @@unique([orderId, shopifyLineItemId]) is correct for uniqueness
-- (orderId already implies a merchantId via FK), but it's the only
-- composite unique in the workspace that does NOT begin with merchantId.
-- That asymmetry creates a subtle tenant-safety footgun under the Prisma
-- extension's findUnique-skip path: a future caller writing
-- `tx.orderLineItem.findUnique({ where: { orderId_shopifyLineItemId: ... } })`
-- from system scope (or a misconfigured tenant scope) bypasses the
-- extension's merchantId injection entirely, since `orderId` is the
-- de-facto tenant discriminator and not validated against the active scope.
--
-- Adding merchantId as a prefix to the unique tuple makes the constraint
-- self-documenting and gives the extension's tenant-assertion path a
-- direct field to match against.  Behaviorally identical for uniqueness
-- (orderId → merchantId is 1:1 via FK); structurally consistent with the
-- rest of the schema.
--
-- Safe to run with existing data:
--   - No row currently exists where (orderId, shopifyLineItemId) is
--     unique but (merchantId, orderId, shopifyLineItemId) is not — adding
--     a column to an already-unique tuple cannot introduce duplicates.
--   - DROP + CREATE inside the same migration tx is atomic in Postgres;
--     no window where the table lacks a unique guard.

-- DropIndex
DROP INDEX "OrderLineItem_orderId_shopifyLineItemId_key";

-- CreateIndex
CREATE UNIQUE INDEX "OrderLineItem_merchantId_orderId_shopifyLineItemId_key"
  ON "OrderLineItem"("merchantId", "orderId", "shopifyLineItemId");
