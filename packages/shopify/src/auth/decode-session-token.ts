/**
 * Session-token JWT verifier (M-8).
 *
 * Thin wrapper over `@shopify/shopify-api`'s
 * `shopify.session.decodeSessionToken`, which uses `jose.jwtVerify`
 * under the hood (HS256 + 10s clock tolerance) and additionally
 * checks `aud === apiKey` when `checkAudience: true`.
 *
 * Our wrapper adds:
 *
 *   - Wrapped error type. SDK throws `InvalidJwtError`; we re-throw
 *     `ShopifySessionTokenError` with a typed `reason` so callers can
 *     map to HTTP responses without import-coupling to the SDK error
 *     hierarchy.
 *
 *   - `dest` check. The JWT's `dest` claim carries the shop the
 *     session was issued for (e.g. `https://foo.myshopify.com`).
 *     A JWT issued for shop X presented to a route asking about shop
 *     Y is a cross-shop replay attempt — reject. The SDK does NOT
 *     check this (it only checks `aud === apiKey`).
 *
 *   - `iss` check. Defense in depth — `iss` is
 *     `https://{shop}/admin` and should also match the expected shop.
 *     Cheap; catches the rare case where a forged token has a
 *     correct `dest` but tampered `iss`.
 *
 *   - Missing-claim check. A JWT can be cryptographically valid (signed
 *     with our secret) but lack `dest` / `iss`. Treat as
 *     `missing_claim` rather than letting it pass.
 *
 * Returns the verified `JwtPayload` on success. Callers MUST NOT
 * trust any claims without going through this wrapper.
 */

import { type JwtPayload, InvalidJwtError } from '@shopify/shopify-api';

import { ShopifySessionTokenError } from '../errors.js';
import { isValidShopDomain } from '../shop-domain.js';
import { getShopifyApiInstance } from './shopify-api-instance.js';

/**
 * Verifies + decodes a session-token JWT, then enforces the dest +
 * iss claims match `expectedShop`. Throws
 * `ShopifySessionTokenError` on any failure.
 *
 * `expectedShop` is the canonical lowercase shop domain (e.g.
 * `foo.myshopify.com`, NO protocol). Callers typically derive this
 * from the URL query param + `normalizeShopDomain`, then pass here.
 *
 * NO DI parameter for the SDK instance. The wrapper always reaches
 * for the module-memoised `getShopifyApiInstance()`. Tests achieve
 * isolation via `vi.spyOn(getShopifyApiInstance(), ...)` on the
 * cached instance — the wrapper sees the same cached instance the
 * test does, so spies are observed transparently. This keeps the
 * public API surface free of a test-only escape hatch that a
 * production caller could misuse.
 */
export async function decodeAndVerifySessionToken(
  token: string,
  expectedShop: string,
): Promise<JwtPayload> {
  if (!isValidShopDomain(expectedShop)) {
    // Defensive — callers should validate before reaching here. Throw
    // a `wrong_dest`-classified error so the caller's 401 mapping
    // works uniformly (vs leaking a different error type).
    throw new ShopifySessionTokenError(
      'wrong_dest',
      `Expected shop is not a valid Shopify shop domain: ${expectedShop}`,
    );
  }

  const api = getShopifyApiInstance();

  // (1) SDK does the cryptographic heavy lifting:
  //     - HS256 signature against apiSecretKey
  //     - exp / nbf with 10s clock tolerance
  //     - aud === apiKey (via checkAudience: true, the default)
  let payload: JwtPayload;
  try {
    payload = await api.session.decodeSessionToken(token, {
      checkAudience: true,
    });
  } catch (err) {
    if (err instanceof InvalidJwtError) {
      // SDK's InvalidJwtError covers both signature + audience
      // failures (see the SDK's decode-session-token.js source).
      // Discriminate by message — the SDK uses a specific string
      // for the audience case. Best-effort; on ambiguity we default
      // to `invalid_jwt` (the broader bucket).
      const reason = err.message.includes('invalid API key')
        ? 'wrong_audience'
        : 'invalid_jwt';
      throw new ShopifySessionTokenError(reason, err.message, { cause: err });
    }
    // Non-SDK error from an SDK call is unexpected (e.g. underlying
    // jose throwing something the SDK doesn't catch). Wrap as
    // invalid_jwt so the caller still gets a 401.
    throw new ShopifySessionTokenError(
      'invalid_jwt',
      `Session-token verification threw unexpectedly: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  // (2) Required claim presence. `dest` is the load-bearing field for
  //     our additional check; `iss` is defense in depth.
  if (typeof payload.dest !== 'string' || payload.dest.length === 0) {
    throw new ShopifySessionTokenError(
      'missing_claim',
      'Session token missing required `dest` claim',
    );
  }
  if (typeof payload.iss !== 'string' || payload.iss.length === 0) {
    throw new ShopifySessionTokenError(
      'missing_claim',
      'Session token missing required `iss` claim',
    );
  }

  // (3) `dest` MUST match expectedShop. Format: `https://{shop}` —
  //     parse via URL constructor for robustness against trailing
  //     slashes / scheme casing.
  const destShop = safeUrlHost(payload.dest);
  if (destShop === null) {
    throw new ShopifySessionTokenError(
      'wrong_dest',
      `Session token \`dest\` is not a valid URL: ${payload.dest}`,
    );
  }
  if (destShop.toLowerCase() !== expectedShop.toLowerCase()) {
    throw new ShopifySessionTokenError(
      'wrong_dest',
      `Session token issued for ${destShop} but presented for ${expectedShop} (cross-shop replay attempt)`,
    );
  }

  // (4) `iss` MUST match expectedShop. Format: `https://{shop}/admin`.
  const issShop = safeUrlHost(payload.iss);
  if (issShop === null) {
    throw new ShopifySessionTokenError(
      'wrong_issuer',
      `Session token \`iss\` is not a valid URL: ${payload.iss}`,
    );
  }
  if (issShop.toLowerCase() !== expectedShop.toLowerCase()) {
    throw new ShopifySessionTokenError(
      'wrong_issuer',
      `Session token \`iss\` shop ${issShop} does not match expected ${expectedShop}`,
    );
  }

  return payload;
}

/**
 * Extract the hostname from a URL string. Returns null on parse
 * failure (vs throwing — the caller wants a clean error path).
 */
function safeUrlHost(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}
