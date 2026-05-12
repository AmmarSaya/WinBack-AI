-- =============================================================================
-- 20260511120000_init
--
-- Baseline migration. SQL body below is the verified canonical output of
-- `prisma migrate diff --from-empty --to-schema-datamodel ./prisma/schema.prisma --script`
-- against schema v2.2, regenerated using prisma 5.22.0. Hand-edits are
-- limited to this header comment block — DO NOT modify any SQL statement
-- below this line without regenerating via the command above.
--
-- Verified delta vs. the original hand-translated draft: Prisma emits one
-- `-- CreateIndex` comment per CREATE INDEX statement (not one per table),
-- and uses `("merchantId","key")` (no space) in the composite PK. The diff
-- was cosmetic but real; canonical output wins per the CP-1 standing rule.
--
-- No DOWN: rollback equals dropping the database (dev/test only — use
-- `pnpm db:reset`; prod is recreate-from-snapshot).
-- =============================================================================

-- CreateEnum
CREATE TYPE "BillingSubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'cancelled', 'paused');

-- CreateEnum
CREATE TYPE "BillingHoldReason" AS ENUM ('shop_on_hold', 'payment_failed', 'plan_change', 'manual_pause', 'fraud_review');

-- CreateEnum
CREATE TYPE "CustomerState" AS ENUM ('active', 'warm', 'at_risk', 'dormant', 'lost');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('active', 'draft', 'archived');

-- CreateEnum
CREATE TYPE "OrderFinancialStatus" AS ENUM ('pending', 'authorized', 'partially_paid', 'paid', 'partially_refunded', 'refunded', 'voided');

-- CreateEnum
CREATE TYPE "OrderFulfillmentStatus" AS ENUM ('fulfilled', 'partial', 'unfulfilled', 'restocked');

-- CreateEnum
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('received', 'processed', 'failed', 'skipped_duplicate');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('system', 'merchant', 'operator');

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyShopId" TEXT,
    "email" TEXT,
    "name" TEXT,
    "country" CHAR(2),
    "currency" CHAR(3),
    "timezone" TEXT,
    "shopifyPlan" TEXT,
    "shopDetailsFetchedAt" TIMESTAMP(3),
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "tokenRevokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantSettings" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "attributionDirectWindowDays" INTEGER NOT NULL DEFAULT 14,
    "attributionAssistedWindowDays" INTEGER NOT NULL DEFAULT 30,
    "sendTimeStartHour" INTEGER NOT NULL DEFAULT 9,
    "sendTimeEndHour" INTEGER NOT NULL DEFAULT 18,
    "defaultCooldownHours" INTEGER NOT NULL DEFAULT 168,
    "maxDailySendsPerCustomer" INTEGER NOT NULL DEFAULT 1,
    "monthlyAiSpendCapCents" BIGINT NOT NULL DEFAULT 50000,
    "monthlySendsCap" INTEGER NOT NULL DEFAULT 1000,
    "aiTone" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingSubscription" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "shopifyChargeId" TEXT,
    "status" "BillingSubscriptionStatus" NOT NULL DEFAULT 'trialing',
    "plan" TEXT,
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodStartsAt" TIMESTAMP(3),
    "currentPeriodEndsAt" TIMESTAMP(3),
    "onHoldReason" "BillingHoldReason",
    "onHoldAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "acceptsMarketing" BOOLEAN NOT NULL DEFAULT false,
    "acceptsSms" BOOLEAN NOT NULL DEFAULT false,
    "ordersCount" INTEGER NOT NULL DEFAULT 0,
    "firstOrderAt" TIMESTAMP(3),
    "lastOrderAt" TIMESTAMP(3),
    "state" "CustomerState" NOT NULL DEFAULT 'active',
    "isVip" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "shopifyCreatedAt" TIMESTAMP(3),
    "shopifyUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "productType" TEXT,
    "vendor" TEXT,
    "status" "ProductStatus" NOT NULL DEFAULT 'active',
    "shopifyCreatedAt" TIMESTAMP(3),
    "shopifyUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "priceCents" BIGINT NOT NULL,
    "compareAtPriceCents" BIGINT,
    "currency" CHAR(3) NOT NULL,
    "inventoryQuantity" INTEGER,
    "shopifyCreatedAt" TIMESTAMP(3),
    "shopifyUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "customerId" TEXT,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderNumber" TEXT,
    "totalAmountCents" BIGINT NOT NULL,
    "subtotalAmountCents" BIGINT NOT NULL,
    "totalTaxCents" BIGINT NOT NULL DEFAULT 0,
    "totalDiscountCents" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "presentmentCurrency" CHAR(3),
    "presentmentTotalCents" BIGINT,
    "financialStatus" "OrderFinancialStatus",
    "fulfillmentStatus" "OrderFulfillmentStatus",
    "placedAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "shopifyUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineItem" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shopifyLineItemId" TEXT NOT NULL,
    "productId" TEXT,
    "productVariantId" TEXT,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookLog" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopifyWebhookId" TEXT,
    "idempotencyKey" TEXT,
    "hmacOk" BOOLEAN NOT NULL,
    "status" "WebhookProcessingStatus" NOT NULL DEFAULT 'received',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "payload" JSONB,
    "payloadUrl" TEXT,
    "payloadSize" INTEGER,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "key" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("merchantId","key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT,
    "shop" TEXT,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_shop_key" ON "Merchant"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_shopifyShopId_key" ON "Merchant"("shopifyShopId");

-- CreateIndex
CREATE INDEX "Merchant_uninstalledAt_idx" ON "Merchant"("uninstalledAt");

-- CreateIndex
CREATE INDEX "Merchant_tokenRevokedAt_idx" ON "Merchant"("tokenRevokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantSettings_merchantId_key" ON "MerchantSettings"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingSubscription_merchantId_key" ON "BillingSubscription"("merchantId");

-- CreateIndex
CREATE INDEX "BillingSubscription_status_idx" ON "BillingSubscription"("status");

-- CreateIndex
CREATE INDEX "BillingSubscription_currentPeriodEndsAt_idx" ON "BillingSubscription"("currentPeriodEndsAt");

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE INDEX "Session_expires_idx" ON "Session"("expires");

-- CreateIndex
CREATE INDEX "Customer_merchantId_state_idx" ON "Customer"("merchantId", "state");

-- CreateIndex
CREATE INDEX "Customer_merchantId_lastOrderAt_idx" ON "Customer"("merchantId", "lastOrderAt");

-- CreateIndex
CREATE INDEX "Customer_merchantId_acceptsMarketing_idx" ON "Customer"("merchantId", "acceptsMarketing");

-- CreateIndex
CREATE INDEX "Customer_merchantId_isVip_idx" ON "Customer"("merchantId", "isVip");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_merchantId_shopifyCustomerId_key" ON "Customer"("merchantId", "shopifyCustomerId");

-- CreateIndex
CREATE INDEX "Product_merchantId_productType_idx" ON "Product"("merchantId", "productType");

-- CreateIndex
CREATE INDEX "Product_merchantId_status_idx" ON "Product"("merchantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Product_merchantId_shopifyProductId_key" ON "Product"("merchantId", "shopifyProductId");

-- CreateIndex
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");

-- CreateIndex
CREATE INDEX "ProductVariant_merchantId_sku_idx" ON "ProductVariant"("merchantId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_merchantId_shopifyVariantId_key" ON "ProductVariant"("merchantId", "shopifyVariantId");

-- CreateIndex
CREATE INDEX "Order_merchantId_customerId_idx" ON "Order"("merchantId", "customerId");

-- CreateIndex
CREATE INDEX "Order_merchantId_placedAt_idx" ON "Order"("merchantId", "placedAt");

-- CreateIndex
CREATE INDEX "Order_merchantId_financialStatus_idx" ON "Order"("merchantId", "financialStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Order_merchantId_shopifyOrderId_key" ON "Order"("merchantId", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "OrderLineItem_merchantId_productId_idx" ON "OrderLineItem"("merchantId", "productId");

-- CreateIndex
CREATE INDEX "OrderLineItem_productVariantId_idx" ON "OrderLineItem"("productVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLineItem_orderId_shopifyLineItemId_key" ON "OrderLineItem"("orderId", "shopifyLineItemId");

-- CreateIndex
CREATE INDEX "WebhookLog_merchantId_receivedAt_idx" ON "WebhookLog"("merchantId", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookLog_shop_receivedAt_idx" ON "WebhookLog"("shop", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookLog_topic_receivedAt_idx" ON "WebhookLog"("topic", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookLog_status_receivedAt_idx" ON "WebhookLog"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookLog_idempotencyKey_idx" ON "WebhookLog"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_processedAt_createdAt_idx" ON "OutboxEvent"("processedAt", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_merchantId_type_createdAt_idx" ON "OutboxEvent"("merchantId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditLog_merchantId_createdAt_idx" ON "AuditLog"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- AddForeignKey
ALTER TABLE "MerchantSettings" ADD CONSTRAINT "MerchantSettings_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSubscription" ADD CONSTRAINT "BillingSubscription_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookLog" ADD CONSTRAINT "WebhookLog_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyKey" ADD CONSTRAINT "IdempotencyKey_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

