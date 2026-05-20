// =============================================================================
// @winback/db — public surface
//
// The factory + extension are intentionally hidden from direct import.
// Consumers receive the typed extended client via createWinbackPrisma; they
// do NOT instantiate PrismaClient themselves and do NOT see the raw client.
//
// Tenant + audit scopes are exported as the single sanctioned way to set
// boundary context. Repositories are the typed write chokepoints.
// =============================================================================

// --- Client factory ---------------------------------------------------------
export { createWinbackPrisma, type WinbackPrisma } from './client.js';

// --- Tenant scoping ---------------------------------------------------------
export {
  withTenantScope,
  withSystemScope,
  getTenantScope,
  assertScopeMatchesMerchant,
  type TenantScope,
  TENANT_SCOPED_MODELS,
  TENANT_OPTIONAL_READ_MODELS,
  SOFT_DELETE_MODELS,
  UNSCOPED_MODELS,
} from './tenant-scope.js';

// --- Audit scoping ----------------------------------------------------------
export { withAudit, getAuditContext, type AuditContext } from './audit-scope.js';

// --- Unit of work + outbox event registry -----------------------------------
export {
  UnitOfWork,
  UnitOfWorkContext,
  UNIT_OF_WORK_DEFAULTS,
  type UnitOfWorkOptions,
  OUTBOX_EVENTS,
  type OutboxEventType,
} from './unit-of-work.js';

// --- Errors -----------------------------------------------------------------
export { TenantScopeError } from './errors.js';

// --- Money parsing (Epic E session 1) ---------------------------------------
export { parseMoneyToCents } from './money.js';

// --- Shopify GID wrap helpers (Epic E session 1) ----------------------------
// Originally placed in @winback/shopify (batch 2) but moved here in batch 3
// to resolve the dependency-direction conflict — repositories consume these
// and @winback/shopify already depends on @winback/db, so the schemas + GID
// helpers belong on the data-layer side of the boundary.
export {
  toShopifyCustomerGid,
  toShopifyLineItemGid,
  toShopifyOrderGid,
  toShopifyProductGid,
  toShopifyVariantGid,
} from './gid.js';

// --- Shopify webhook body schemas (Epic E session 1) ------------------------
export {
  shopifyCustomerWebhookBodySchema,
  shopifyOrderWebhookBodySchema,
  type ShopifyCustomerWebhookBody,
  type ShopifyMoneySet,
  type ShopifyOrderLineItem,
  type ShopifyOrderWebhookBody,
} from './webhook-bodies.js';

// --- Repositories -----------------------------------------------------------
export * from './repositories/index.js';

// --- Outbox event producer schemas (Epic E session 2) -----------------------
export * from './events/index.js';

// --- Services (Epic E session 2 — CustomerScoreService + pure scoring math) -
export * from './services/index.js';

// --- Compliance (C6 — GDPR processors) -------------------------------------
export * from './compliance/index.js';
