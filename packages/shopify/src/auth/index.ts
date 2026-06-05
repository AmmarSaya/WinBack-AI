/**
 * `@winback/shopify/auth` — Token Exchange + session-token verification
 * surface (M-8).
 *
 * The only install + re-bootstrap path post-B4. The legacy code-grant
 * helpers (`buildAuthRedirectUrl`, `exchangeCodeForToken` from
 * `../oauth.ts`) were deleted alongside `/auth.tsx`'s Branch B and
 * `/auth.callback.tsx` in M-8 Commit 4 (L2-H1 closure).
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
