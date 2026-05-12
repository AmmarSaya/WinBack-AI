import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-SHA256 helpers with timing-safe verification.
 *
 * NEVER compare HMAC values with `===` or `.equals` — string comparison
 * leaks length and content via timing. Always use `timingSafeEqual` on
 * equal-length buffers.
 */

export function computeHmacSha256(secret: string, message: string | Buffer): Buffer {
  return createHmac('sha256', secret).update(message).digest();
}

export function computeHmacSha256Hex(secret: string, message: string | Buffer): string {
  return computeHmacSha256(secret, message).toString('hex');
}

/**
 * Verifies an HMAC-SHA256 against a hex-encoded expected value.
 * Used for Shopify OAuth callback HMAC (which Shopify sends as hex).
 */
export function verifyHmacSha256Hex(
  secret: string,
  message: string | Buffer,
  expectedHex: string,
): boolean {
  const computed = computeHmacSha256(secret, message);
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== computed.length) return false;
  return timingSafeEqual(computed, expected);
}

/**
 * Verifies an HMAC-SHA256 against a base64-encoded expected value.
 * Used for Shopify webhook HMAC (sent as base64 in `X-Shopify-Hmac-Sha256`).
 */
export function verifyHmacSha256Base64(
  secret: string,
  message: string | Buffer,
  expectedBase64: string,
): boolean {
  const computed = computeHmacSha256(secret, message);
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedBase64, 'base64');
  } catch {
    return false;
  }
  if (expected.length !== computed.length) return false;
  return timingSafeEqual(computed, expected);
}
