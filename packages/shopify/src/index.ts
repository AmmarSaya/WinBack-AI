// =============================================================================
// @winback/shopify — public surface
//
// HMAC ordering invariant (locked at C1):
//   Every Shopify entrypoint (OAuth callback, webhook) MUST verify HMAC at
//   the boundary BEFORE any database access. Reject 401 on failure with no
//   Prisma call, no scope setup, nothing. This keeps the tenant scope from
//   ever being established on an unauthenticated request.
//
// Pre-tenant window:
//   `completeInstall` is the ONE function that creates a Merchant row, and
//   it opens `withSystemScope('shopify.install')` because no tenant exists
//   yet. Session writes (`EncryptedSessionStorage`) happen against the
//   UNSCOPED `Session` model — no scope required.
// =============================================================================

// --- Config ----------------------------------------------------------------
export {
  getShopifyConfig,
  parseScopes,
  type ShopifyConfig,
  type GetShopifyConfigOptions,
} from './config.js';

// --- Errors ----------------------------------------------------------------
export {
  ShopifyHmacError,
  ShopifyInvalidShopError,
  ShopifySessionTokenError,
  ShopifyTokenExchangeError,
  type ShopifySessionTokenErrorReason,
} from './errors.js';

// --- Shop domain validation ------------------------------------------------
export { isValidShopDomain, normalizeShopDomain } from './shop-domain.js';

// --- HMAC primitives (Shopify-format) --------------------------------------
export { verifyShopifyOAuthHmac, verifyShopifyWebhookHmac } from './hmac.js';

// --- Webhook topic dispatch ------------------------------------------------
export {
  GDPR_TOPICS,
  GDPR_TOPIC_TO_EVENT,
  WEBHOOK_TOPIC_TO_EVENT,
  getOutboxEventForTopic,
  isGdprTopic,
  isKnownTopic,
} from './webhook-topics.js';

// --- OAuth -----------------------------------------------------------------
// Legacy code-grant helpers — used by the existing /auth + /auth.callback
// routes. Coexist with the M-8 Token Exchange path below until those
// routes are decommissioned (separate session per Phase 1 scope).
export {
  buildAuthRedirectUrl,
  exchangeCodeForToken,
  type AuthRedirectArgs,
  type TokenExchangeResult,
} from './oauth.js';

// --- M-8 Token Exchange + session-token verification -----------------------
// New auth surface for the Token Exchange migration. See ./auth/index.ts
// for the public surface + ./auth/decode-session-token.ts +
// ./auth/token-exchange.ts for the wrapped SDK helpers.
export {
  RequestedTokenType,
  _resetShopifyApiInstanceForTests,
  decodeAndVerifySessionToken,
  getShopifyApiInstance,
  tokenExchangeForShop,
  type TokenExchangeForShopArgs,
  type TokenExchangeForShopResult,
} from './auth/index.js';

// --- Session storage -------------------------------------------------------
export { EncryptedSessionStorage } from './session-storage.js';

// --- Install flow ----------------------------------------------------------
export {
  completeInstall,
  type CompleteInstallArgs,
  type CompleteInstallResult,
} from './install.js';

// --- Admin API client (C4) -------------------------------------------------
export * from './admin/index.js';

// --- Backfill + install enrichment (C5) ------------------------------------
export * from './backfill/index.js';

// NOTE: GID wrap helpers + Shopify webhook body schemas were originally
// placed in this package (batch 2 of Epic E session 1) but moved to
// @winback/db in batch 3 to resolve a circular import: @winback/shopify
// already depends on @winback/db (for WinbackPrisma, repositories,
// withSystemScope), so repositories in @winback/db cannot import from
// here. Schemas describe DB-bound data shapes — the data layer is the
// right place. Import from @winback/db:
//   import { toShopifyOrderGid, shopifyOrderWebhookBodySchema, ... } from '@winback/db';
