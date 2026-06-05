import { verifyHmacSha256Base64 } from '@winback/crypto';

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
 *
 * Pre-B4 this file also held `verifyShopifyOAuthHmac` +
 * `canonicalizeQueryForHmac` for the legacy code-grant callback. Both
 * deleted in B4 (M-8 Commit 4) alongside the rest of the legacy auth
 * path. Only webhook HMAC verification remains.
 */

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
