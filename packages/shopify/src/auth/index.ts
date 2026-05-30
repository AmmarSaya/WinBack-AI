/**
 * `@winback/shopify/auth` — Token Exchange + session-token verification
 * surface for M-8.
 *
 * Coexists with the legacy code-grant helpers in `../oauth.ts`
 * (`buildAuthRedirectUrl`, `exchangeCodeForToken`) for the migration
 * window. Code-grant helpers will be removed in a follow-up commit
 * once `/auth.tsx` + `/auth.callback.tsx` are decommissioned.
 *
 * Public surface:
 *
 *   - `decodeAndVerifySessionToken(token, expectedShop)` — JWT verify
 *     + `dest` + `iss` shop-match checks. Throws
 *     `ShopifySessionTokenError` on failure.
 *
 *   - `tokenExchangeForShop({ shop, sessionToken, requestedTokenType? })`
 *     — Token Exchange call. Returns the SDK's `Session` with
 *     `accessToken` set. Throws `ShopifyInvalidShopError` or
 *     `ShopifyTokenExchangeError`.
 *
 *   - `RequestedTokenType` enum re-export (offline / online).
 *
 *   - `getShopifyApiInstance` is internal but exported for
 *     `apps/web/app/routes/auth.tsx` (commit 2's Token Exchange
 *     bootstrap route) to avoid a third `shopifyApi({...})` instance.
 *     Production callers outside this package should NOT use it
 *     directly — go through the wrappers.
 */

export { decodeAndVerifySessionToken } from './decode-session-token.js';

export {
  RequestedTokenType,
  tokenExchangeForShop,
  type TokenExchangeForShopArgs,
  type TokenExchangeForShopResult,
} from './token-exchange.js';

export {
  _resetShopifyApiInstanceForTests,
  getShopifyApiInstance,
} from './shopify-api-instance.js';
