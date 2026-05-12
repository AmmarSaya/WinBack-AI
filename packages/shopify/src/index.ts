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

// --- Types -----------------------------------------------------------------
export type { ShopifySession, SessionStorage } from './types.js';

// --- Errors ----------------------------------------------------------------
export {
  ShopifyHmacError,
  ShopifyInvalidShopError,
  ShopifyTokenExchangeError,
} from './errors.js';

// --- Shop domain validation ------------------------------------------------
export { isValidShopDomain, normalizeShopDomain } from './shop-domain.js';

// --- HMAC primitives (Shopify-format) --------------------------------------
export { verifyShopifyOAuthHmac, verifyShopifyWebhookHmac } from './hmac.js';

// --- Webhook topic dispatch ------------------------------------------------
export {
  GDPR_TOPICS,
  WEBHOOK_TOPIC_TO_EVENT,
  getOutboxEventForTopic,
  isGdprTopic,
  isKnownTopic,
} from './webhook-topics.js';

// --- OAuth -----------------------------------------------------------------
export {
  buildAuthRedirectUrl,
  exchangeCodeForToken,
  type AuthRedirectArgs,
  type TokenExchangeResult,
} from './oauth.js';

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
