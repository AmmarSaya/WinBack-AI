/**
 * Token Exchange wrapper (M-8 — RFC 8693 via Shopify's offline-token
 * grant). The only install + re-bootstrap path post-B4. The pre-B4
 * code-grant `exchangeCodeForToken` in oauth.ts was deleted alongside
 * the rest of the legacy auth path (M-8 Commit 4 / L2-H1 closure).
 *
 * Thin wrapper over `@shopify/shopify-api`'s
 * `shopify.auth.tokenExchange`, which posts to
 * `https://{shop}/admin/oauth/access_token` with the
 * `urn:ietf:params:oauth:grant-type:token-exchange` grant type and
 * the App Bridge session-token JWT as `subject_token`.
 *
 * Our wrapper adds:
 *
 *   - Shop-domain validation at the boundary. Defensive against
 *     callers passing malformed shop strings (the SDK would also
 *     reject but the error type is less useful for HTTP mapping).
 *
 *   - Typed error wrapping. SDK errors become
 *     `ShopifyTokenExchangeError` (exported from
 *     `@winback/shopify/errors`), the same type the pre-B4 code-grant
 *     path used — kept stable so any caller catching it doesn't need
 *     to change.
 *
 *   - Returns the populated `Session` object directly. The SDK's
 *     return shape `{ session }` is convenient at this layer and
 *     keeps the embedded `EncryptedSessionStorage.storeSession`
 *     call shape unchanged from the legacy path.
 *
 * Online vs offline:
 *   - **Offline** (`RequestedTokenType.OfflineAccessToken`) is the
 *     v1 default for our app. Long-lived API token tied to the
 *     merchant (shop), not a specific user. Used by webhooks +
 *     backfills + AI generation.
 *   - **Online** (`RequestedTokenType.OnlineAccessToken`) is the
 *     short-lived per-user token. We currently don't use it; the
 *     parameter is exposed for forward compatibility (some operator
 *     dashboards / multi-user admin features in M10 may need it).
 */

import { RequestedTokenType, type Session } from '@shopify/shopify-api';

import { ShopifyInvalidShopError, ShopifyTokenExchangeError } from '../errors.js';
import { isValidShopDomain } from '../shop-domain.js';
import { getShopifyApiInstance } from './shopify-api-instance.js';

// Re-export the SDK's enum so callers don't import directly from the
// SDK package (lets us swap the SDK version without ripple).
export { RequestedTokenType };

export interface TokenExchangeForShopArgs {
  /** Canonical Shopify shop domain (e.g. `foo.myshopify.com`). */
  readonly shop: string;
  /** App Bridge session-token JWT. Must already have been verified
   *  via `decodeAndVerifySessionToken` — the SDK does verify again
   *  internally, but verifying upstream gives us a typed error path
   *  before the network call fires. */
  readonly sessionToken: string;
  /**
   * Which token type to request from Shopify. Defaults to offline
   * (our v1 install pattern).
   */
  readonly requestedTokenType?: RequestedTokenType;
}

export interface TokenExchangeForShopResult {
  /**
   * The SDK-returned `Session` object with `accessToken` set. Hand
   * this directly to `EncryptedSessionStorage.storeSession` — the
   * decorator handles encryption + the underlying Prisma adapter
   * handles persistence.
   */
  readonly session: Session;
}

/**
 * Performs the Token Exchange flow with Shopify, returning a
 * populated `Session` ready for storage. Throws
 * `ShopifyInvalidShopError` for malformed shops + `ShopifyTokenExchangeError`
 * for SDK-side failures (network, 4xx/5xx response, invalid_grant,
 * etc.).
 *
 * NO DI parameter for the SDK instance — see
 * `decodeAndVerifySessionToken` for the same reasoning. Tests achieve
 * isolation via `vi.spyOn(getShopifyApiInstance().auth, 'tokenExchange')`.
 */
export async function tokenExchangeForShop(
  args: TokenExchangeForShopArgs,
): Promise<TokenExchangeForShopResult> {
  if (!isValidShopDomain(args.shop)) {
    throw new ShopifyInvalidShopError(args.shop);
  }

  const api = getShopifyApiInstance();
  const requestedTokenType =
    args.requestedTokenType ?? RequestedTokenType.OfflineAccessToken;

  try {
    const result = await api.auth.tokenExchange({
      shop: args.shop,
      sessionToken: args.sessionToken,
      requestedTokenType,
    });
    return { session: result.session };
  } catch (err) {
    // SDK can throw various error subclasses (HttpResponseError,
    // HttpRetriableError, ShopifyError, plain Error from underlying
    // fetch). Map them all to ShopifyTokenExchangeError to give
    // callers ONE error type to catch + a `providerStatus` when
    // available.
    const providerStatus = extractProviderStatus(err);
    const message =
      err instanceof Error ? err.message : String(err);
    throw new ShopifyTokenExchangeError(
      `Shopify token exchange failed: ${message}`,
      providerStatus !== null
        ? { providerStatus, cause: err }
        : { cause: err },
    );
  }
}

/**
 * Best-effort extraction of an HTTP status code from various SDK
 * error shapes. Returns null if no status is available (network
 * error before any response).
 */
function extractProviderStatus(err: unknown): number | null {
  if (err === null || typeof err !== 'object') return null;
  const maybeResponse = (err as { response?: unknown }).response;
  if (
    maybeResponse !== null &&
    typeof maybeResponse === 'object' &&
    'code' in maybeResponse &&
    typeof (maybeResponse as { code: unknown }).code === 'number'
  ) {
    return (maybeResponse as { code: number }).code;
  }
  return null;
}
