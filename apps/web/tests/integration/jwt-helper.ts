import { createHmac } from 'node:crypto';

/**
 * Shared session-token JWT construction for integration tests.
 *
 * Mirrors packages/shopify/tests/auth/decode-session-token.test.ts —
 * real HS256 JWTs against `process.env.SHOPIFY_API_SECRET` (set by
 * scripts/web-test.mjs) so a future SDK upgrade that changes JWT
 * verification semantics fails the integration suite loudly.
 *
 * `aud` defaults to `process.env.SHOPIFY_API_KEY`. Override per-test
 * for audience-mismatch scenarios; override `secret` for bad-signature
 * scenarios; override `dest` / `iss` for cross-shop scenarios.
 */

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export interface JwtOverrides {
  readonly aud?: string;
  readonly dest?: string;
  readonly iss?: string;
  readonly exp?: number;
  readonly nbf?: number;
  readonly secret?: string;
}

export function makeSessionToken(shop: string, overrides: JwtOverrides = {}): string {
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('SHOPIFY_API_KEY not set — run via `pnpm web:test`.');
  }
  if (apiSecret === undefined || apiSecret.length === 0) {
    throw new Error('SHOPIFY_API_SECRET not set — run via `pnpm web:test`.');
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: overrides.iss ?? `https://${shop}/admin`,
    dest: overrides.dest ?? `https://${shop}`,
    aud: overrides.aud ?? apiKey,
    sub: '12345',
    exp: overrides.exp ?? now + 60,
    nbf: overrides.nbf ?? now - 60,
    iat: now,
    jti: `test-jti-${String(now)}-${Math.random().toString(36).slice(2)}`,
    sid: 'test-sid',
  };
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const sig = base64url(
    createHmac('sha256', overrides.secret ?? apiSecret).update(`${header}.${body}`).digest(),
  );
  return `${header}.${body}.${sig}`;
}
