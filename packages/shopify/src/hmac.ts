import { verifyHmacSha256Base64, verifyHmacSha256Hex } from '@winback/crypto';

/**
 * Shopify-specific HMAC verification.
 *
 * ORDERING INVARIANT (locked in C1, enforced at every Shopify entrypoint):
 *
 *   1. Verify HMAC.
 *   2. If invalid → reject 401 immediately. NO DB access. NO scope setup.
 *   3. If valid → proceed to authenticated handler code.
 *
 * The tenant scope is established only AFTER HMAC succeeds, so the
 * extension's error surface stays clean — unauthenticated requests never
 * touch the database. C2 (Remix routes) MUST enforce step 2.
 */

/**
 * Verifies the HMAC on a Shopify OAuth callback query string.
 *
 * Shopify computes HMAC-SHA256 over the request's query parameters
 * (excluding `hmac` and `signature` themselves), sorted by key, joined
 * `k=v&k=v`. The result is sent as a hex-encoded string in the `hmac`
 * query parameter.
 *
 * Returns `false` on any malformation (missing hmac, wrong length, etc.).
 * Throws nothing — callers branch on the boolean.
 */
export function verifyShopifyOAuthHmac(
  secret: string,
  query: Record<string, string | string[] | undefined>,
): boolean {
  const hmacValue = query['hmac'];
  if (typeof hmacValue !== 'string' || hmacValue.length === 0) {
    return false;
  }
  const message = canonicalizeQueryForHmac(query);
  return verifyHmacSha256Hex(secret, message, hmacValue);
}

/**
 * Verifies the HMAC on a Shopify webhook request.
 *
 * The HMAC is computed over the RAW request body (bytes-exact, before any
 * JSON parsing — including whitespace and key order). Compute on the
 * unmodified raw body or you will see false negatives. The expected value
 * comes from the `X-Shopify-Hmac-Sha256` header, base64-encoded.
 *
 * Callers MUST hold the raw body (not a parsed object) at the moment they
 * verify. A common bug: framework middleware that auto-parses JSON before
 * the webhook handler runs. Configure raw-body access ahead of JSON
 * parsing.
 */
export function verifyShopifyWebhookHmac(
  secret: string,
  rawBody: string | Buffer,
  headerValue: string,
): boolean {
  if (typeof headerValue !== 'string' || headerValue.length === 0) {
    return false;
  }
  return verifyHmacSha256Base64(secret, rawBody, headerValue);
}

/**
 * Produces Shopify's canonical query-string message for HMAC.
 * - Excludes the `hmac` and `signature` keys themselves.
 * - Sorts keys lexicographically.
 * - Joins `k=v` pairs with `&`.
 * - For multi-valued keys, comma-joins the values.
 */
function canonicalizeQueryForHmac(
  query: Record<string, string | string[] | undefined>,
): string {
  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries(query)) {
    if (k === 'hmac' || k === 'signature') continue;
    if (v === undefined) continue;
    const value = Array.isArray(v) ? v.join(',') : v;
    entries.push([k, value]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join('&');
}
