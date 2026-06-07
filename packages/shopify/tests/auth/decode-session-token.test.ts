/**
 * Unit tests for `decodeAndVerifySessionToken` (M-8 Commit 1).
 *
 * Construction strategy: build REAL JWTs with `node:crypto` HMAC-SHA256
 * + the test API secret. Pass them through the wrapper, which uses the
 * REAL SDK `decodeSessionToken` (no SDK mocking — the SDK does the JWT
 * verification + audience check, and we want those code paths
 * exercised end-to-end so a future SDK upgrade can't silently change
 * verification semantics without failing here).
 *
 * Only the `_api` override seam is used (test-only) to swap in a
 * Shopify instance built from TEST_ENV rather than the workspace-
 * default config. The `_resetShopifyApiInstanceForTests` test hook is
 * called in `beforeEach` so each test gets a fresh memoised instance.
 */

import { createHmac } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetShopifyApiInstanceForTests,
  decodeAndVerifySessionToken,
} from '../../src/auth/index.js';
import { getShopifyConfig } from '../../src/config.js';
import {
  ShopifySessionTokenError,
  type ShopifySessionTokenErrorReason,
} from '../../src/errors.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-12345abcdef';
const TEST_API_SECRET =
  'test-api-secret-at-least-thirty-two-bytes-long-for-hmac-key-safety-OK';
const SHOP = 'foo.myshopify.com';
const SHOP_OTHER = 'other-shop.myshopify.com';

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  SHOPIFY_API_KEY: TEST_API_KEY,
  SHOPIFY_API_SECRET: TEST_API_SECRET,
  SHOPIFY_APP_URL: 'https://test.invalid',
  SHOPIFY_SCOPES: 'read_customers,read_orders',
  SHOPIFY_API_VERSION: '2026-04',
  ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
};

beforeEach(() => {
  // Reset both config + Shopify SDK instance so each test gets a
  // fresh instance constructed from TEST_ENV (not from the workspace
  // .env or vitest config).
  getShopifyConfig({ reset: true, source: TEST_ENV });
  _resetShopifyApiInstanceForTests();
});

// ---------------------------------------------------------------------------
// JWT construction helpers
// ---------------------------------------------------------------------------

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  return `${header}.${body}.${base64url(sig)}`;
}

interface PayloadOverrides {
  iss?: string | undefined;
  dest?: string | undefined;
  aud?: string;
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
}

function makePayload(overrides: PayloadOverrides = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const base: Record<string, unknown> = {
    sub: '12345',
    aud: overrides.aud ?? TEST_API_KEY,
    exp: overrides.exp ?? now + 60,
    nbf: overrides.nbf ?? now - 60,
    iat: overrides.iat ?? now,
    jti: 'test-jti',
    sid: 'test-sid',
  };
  // `dest` + `iss` use `in` semantics so a test can explicitly omit
  // them via `{ dest: undefined }`.
  if ('dest' in overrides) {
    if (overrides.dest !== undefined) base.dest = overrides.dest;
  } else {
    base.dest = `https://${SHOP}`;
  }
  if ('iss' in overrides) {
    if (overrides.iss !== undefined) base.iss = overrides.iss;
  } else {
    base.iss = `https://${SHOP}/admin`;
  }
  return base;
}

async function expectRejectsWithReason(
  promise: Promise<unknown>,
  reason: ShopifySessionTokenErrorReason,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ShopifySessionTokenError);
  try {
    await promise;
  } catch (err) {
    expect((err as ShopifySessionTokenError).reason).toBe(reason);
  }
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('decodeAndVerifySessionToken — happy path', () => {
  it('valid JWT signed with our secret → returns JwtPayload with all standard claims', async () => {
    const token = signJwt(makePayload(), TEST_API_SECRET);
    const payload = await decodeAndVerifySessionToken(token, SHOP);

    expect(payload.dest).toBe(`https://${SHOP}`);
    expect(payload.iss).toBe(`https://${SHOP}/admin`);
    expect(payload.aud).toBe(TEST_API_KEY);
    expect(payload.sub).toBe('12345');
    expect(typeof payload.exp).toBe('number');
  });

  it('expectedShop in MIXED CASE is accepted (case-insensitive comparison)', async () => {
    const token = signJwt(makePayload(), TEST_API_SECRET);
    const payload = await decodeAndVerifySessionToken(token, SHOP.toUpperCase());
    expect(payload.dest).toBe(`https://${SHOP}`);
  });
});

// ---------------------------------------------------------------------------
// Malformed JWT
// ---------------------------------------------------------------------------

describe('decodeAndVerifySessionToken — malformed JWT', () => {
  it('garbage non-JWT string → invalid_jwt', async () => {
    await expectRejectsWithReason(
      decodeAndVerifySessionToken('not-a-jwt-at-all', SHOP),
      'invalid_jwt',
    );
  });

  it('JWT missing the signature segment (only header.body, no third dot) → invalid_jwt', async () => {
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = base64url(JSON.stringify(makePayload()));
    await expectRejectsWithReason(
      decodeAndVerifySessionToken(`${header}.${body}`, SHOP),
      'invalid_jwt',
    );
  });

  it('empty string → invalid_jwt', async () => {
    await expectRejectsWithReason(
      decodeAndVerifySessionToken('', SHOP),
      'invalid_jwt',
    );
  });
});

// ---------------------------------------------------------------------------
// Cryptographic failures
// ---------------------------------------------------------------------------

describe('decodeAndVerifySessionToken — cryptographic failures', () => {
  it('JWT signed with the WRONG secret → invalid_jwt', async () => {
    const token = signJwt(makePayload(), 'a-completely-different-secret-key');
    await expectRejectsWithReason(
      decodeAndVerifySessionToken(token, SHOP),
      'invalid_jwt',
    );
  });

  it('expired token (exp in past) → invalid_jwt', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt(
      makePayload({ exp: now - 3600, nbf: now - 7200, iat: now - 7200 }),
      TEST_API_SECRET,
    );
    await expectRejectsWithReason(
      decodeAndVerifySessionToken(token, SHOP),
      'invalid_jwt',
    );
  });

  it('nbf within 10s tolerance (slightly in future) → accepted (SDK clockTolerance: 10s)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt(
      // nbf 5s in the future — within SDK's 10s tolerance.
      makePayload({ nbf: now + 5, iat: now, exp: now + 60 }),
      TEST_API_SECRET,
    );
    const payload = await decodeAndVerifySessionToken(token, SHOP);
    expect(payload.dest).toBe(`https://${SHOP}`);
  });

  it('nbf 60s in the future (well beyond 10s tolerance) → invalid_jwt', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt(
      makePayload({ nbf: now + 60, iat: now, exp: now + 120 }),
      TEST_API_SECRET,
    );
    await expectRejectsWithReason(
      decodeAndVerifySessionToken(token, SHOP),
      'invalid_jwt',
    );
  });
});

// ---------------------------------------------------------------------------
// Audience failure (SDK's checkAudience: true)
// ---------------------------------------------------------------------------

describe('decodeAndVerifySessionToken — audience check', () => {
  it('aud claim does NOT match our API key → wrong_audience', async () => {
    const token = signJwt(
      makePayload({ aud: 'a-different-apps-api-key' }),
      TEST_API_SECRET,
    );
    await expectRejectsWithReason(
      decodeAndVerifySessionToken(token, SHOP),
      'wrong_audience',
    );
  });
});

// ---------------------------------------------------------------------------
// dest / iss shop checks (our additions over SDK)
// ---------------------------------------------------------------------------

describe('decodeAndVerifySessionToken — dest claim shop-match', () => {
  it('dest carries a DIFFERENT shop than expectedShop → wrong_dest (cross-shop replay defence)', async () => {
    const token = signJwt(
      makePayload({ dest: `https://${SHOP_OTHER}` }),
      TEST_API_SECRET,
    );
    await expectRejectsWithReason(
      decodeAndVerifySessionToken(token, SHOP),
      'wrong_dest',
    );
  });

  it('dest claim is not a valid URL → wrong_dest', async () => {
    const token = signJwt(
      makePayload({ dest: 'not a url at all' }),
      TEST_API_SECRET,
    );
    await expectRejectsWithReason(
      decodeAndVerifySessionToken(token, SHOP),
      'wrong_dest',
    );
  });

  it('dest claim absent → missing_claim', async () => {
    const token = signJwt(
      makePayload({ dest: undefined }),
      TEST_API_SECRET,
    );
    await expectRejectsWithReason(
      decodeAndVerifySessionToken(token, SHOP),
      'missing_claim',
    );
  });
});

describe('decodeAndVerifySessionToken — iss claim shop-match', () => {
  it('iss carries a DIFFERENT shop than expectedShop → wrong_issuer', async () => {
    const token = signJwt(
      makePayload({ iss: `https://${SHOP_OTHER}/admin` }),
      TEST_API_SECRET,
    );
    await expectRejectsWithReason(
      decodeAndVerifySessionToken(token, SHOP),
      'wrong_issuer',
    );
  });

  it('iss claim is not a valid URL → wrong_issuer', async () => {
    const token = signJwt(
      makePayload({ iss: 'garbage' }),
      TEST_API_SECRET,
    );
    await expectRejectsWithReason(
      decodeAndVerifySessionToken(token, SHOP),
      'wrong_issuer',
    );
  });

  it('iss claim absent → missing_claim', async () => {
    const token = signJwt(
      makePayload({ iss: undefined }),
      TEST_API_SECRET,
    );
    await expectRejectsWithReason(
      decodeAndVerifySessionToken(token, SHOP),
      'missing_claim',
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid expectedShop parameter (defensive)
// ---------------------------------------------------------------------------

describe('decodeAndVerifySessionToken — invalid expectedShop param', () => {
  it('expectedShop is a malformed domain → wrong_dest (defensive)', async () => {
    const token = signJwt(makePayload(), TEST_API_SECRET);
    await expectRejectsWithReason(
      decodeAndVerifySessionToken(token, 'not a real shop domain'),
      'wrong_dest',
    );
  });

  it('expectedShop is empty string → wrong_dest', async () => {
    const token = signJwt(makePayload(), TEST_API_SECRET);
    await expectRejectsWithReason(
      decodeAndVerifySessionToken(token, ''),
      'wrong_dest',
    );
  });
});
