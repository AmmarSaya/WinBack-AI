/**
 * Unit tests for `tokenExchangeForShop` (M-8 Commit 1).
 *
 * Strategy: build a REAL Shopify SDK instance via the
 * `getShopifyApiInstance()` (so the wrapper exercises actual instance
 * shape), then spy on `api.auth.tokenExchange` per-test to control
 * what the SDK returns. We don't go through the actual network
 * (`shopify.auth.tokenExchange` would POST to
 * `https://{shop}/admin/oauth/access_token`) — that's covered by the
 * integration test in Commit 2.
 */

import { Session } from '@shopify/shopify-api';
import { HttpResponseError } from '@shopify/shopify-api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RequestedTokenType,
  _resetShopifyApiInstanceForTests,
  getShopifyApiInstance,
  tokenExchangeForShop,
} from '../../src/auth/index.js';
import { getShopifyConfig } from '../../src/config.js';
import {
  ShopifyInvalidShopError,
  ShopifyTokenExchangeError,
} from '../../src/errors.js';

const TEST_API_KEY = 'test-api-key-12345abcdef';
const TEST_API_SECRET =
  'test-api-secret-at-least-thirty-two-bytes-long-for-hmac-key-safety-OK';
const SHOP = 'foo.myshopify.com';
const FAKE_JWT = 'fake.jwt.token';
const FAKE_ACCESS_TOKEN = 'shpat_fake_test_token_for_unit_tests';

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
  getShopifyConfig({ reset: true, source: TEST_ENV });
  _resetShopifyApiInstanceForTests();
});

function makeFakeSession(overrides: Partial<{
  id: string;
  shop: string;
  isOnline: boolean;
  scope: string;
  accessToken: string;
}> = {}): Session {
  return new Session({
    id: overrides.id ?? `offline_${SHOP}`,
    shop: overrides.shop ?? SHOP,
    state: '',
    isOnline: overrides.isOnline ?? false,
    scope: overrides.scope ?? 'read_customers,read_orders',
    accessToken: overrides.accessToken ?? FAKE_ACCESS_TOKEN,
  });
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe('tokenExchangeForShop — happy path', () => {
  it('valid shop + JWT (defaults to offline) → returns SDK Session with accessToken', async () => {
    const api = getShopifyApiInstance();
    const fakeSession = makeFakeSession();
    const spy = vi
      .spyOn(api.auth, 'tokenExchange')
      .mockResolvedValue({ session: fakeSession });

    const result = await tokenExchangeForShop({
      shop: SHOP,
      sessionToken: FAKE_JWT,
    });

    expect(result.session).toBe(fakeSession);
    expect(result.session.accessToken).toBe(FAKE_ACCESS_TOKEN);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      shop: SHOP,
      sessionToken: FAKE_JWT,
      requestedTokenType: RequestedTokenType.OfflineAccessToken,
    });
  });

  it('explicit offline token type → propagates to SDK', async () => {
    const api = getShopifyApiInstance();
    vi.spyOn(api.auth, 'tokenExchange').mockResolvedValue({
      session: makeFakeSession({ isOnline: false }),
    });

    await tokenExchangeForShop({
      shop: SHOP,
      sessionToken: FAKE_JWT,
      requestedTokenType: RequestedTokenType.OfflineAccessToken,
    });

    const call = vi.mocked(api.auth.tokenExchange).mock.calls[0]!;
    expect(call[0].requestedTokenType).toBe(
      RequestedTokenType.OfflineAccessToken,
    );
  });

  it('explicit online token type → propagates to SDK', async () => {
    const api = getShopifyApiInstance();
    const onlineSession = makeFakeSession({
      id: `online_${SHOP}_user_5`,
      isOnline: true,
    });
    vi.spyOn(api.auth, 'tokenExchange').mockResolvedValue({
      session: onlineSession,
    });

    const result = await tokenExchangeForShop({
      shop: SHOP,
      sessionToken: FAKE_JWT,
      requestedTokenType: RequestedTokenType.OnlineAccessToken,
    });

    expect(result.session.isOnline).toBe(true);
    const call = vi.mocked(api.auth.tokenExchange).mock.calls[0]!;
    expect(call[0].requestedTokenType).toBe(
      RequestedTokenType.OnlineAccessToken,
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid input
// ---------------------------------------------------------------------------

describe('tokenExchangeForShop — invalid input', () => {
  it('malformed shop domain → ShopifyInvalidShopError (no SDK call)', async () => {
    const api = getShopifyApiInstance();
    const spy = vi.spyOn(api.auth, 'tokenExchange');

    await expect(
      tokenExchangeForShop({
        shop: 'not a real shop',
        sessionToken: FAKE_JWT,
      }),
    ).rejects.toBeInstanceOf(ShopifyInvalidShopError);

    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SDK failures → mapped to ShopifyTokenExchangeError
// ---------------------------------------------------------------------------

describe('tokenExchangeForShop — SDK error mapping', () => {
  it('SDK throws HttpResponseError (4xx with status) → ShopifyTokenExchangeError with providerStatus', async () => {
    const api = getShopifyApiInstance();
    const sdkErr = new HttpResponseError({
      message: 'invalid_grant',
      code: 400,
      statusText: 'Bad Request',
      body: { error: 'invalid_grant' },
    });
    vi.spyOn(api.auth, 'tokenExchange').mockRejectedValue(sdkErr);

    try {
      await tokenExchangeForShop({
        shop: SHOP,
        sessionToken: FAKE_JWT,
      });
      throw new Error('expected ShopifyTokenExchangeError');
    } catch (err) {
      expect(err).toBeInstanceOf(ShopifyTokenExchangeError);
      const wrapped = err as ShopifyTokenExchangeError & {
        providerStatus?: number;
      };
      expect(wrapped.providerStatus).toBe(400);
      expect(wrapped.message).toContain('invalid_grant');
    }
  });

  it('SDK throws network-class Error (no providerStatus) → ShopifyTokenExchangeError without providerStatus', async () => {
    const api = getShopifyApiInstance();
    vi.spyOn(api.auth, 'tokenExchange').mockRejectedValue(
      new Error('ECONNRESET'),
    );

    try {
      await tokenExchangeForShop({
        shop: SHOP,
        sessionToken: FAKE_JWT,
      });
      throw new Error('expected ShopifyTokenExchangeError');
    } catch (err) {
      expect(err).toBeInstanceOf(ShopifyTokenExchangeError);
      const wrapped = err as ShopifyTokenExchangeError & {
        providerStatus?: number;
      };
      expect(wrapped.providerStatus).toBeUndefined();
      expect(wrapped.message).toContain('ECONNRESET');
    }
  });

  it('SDK throws a non-Error value (string) → ShopifyTokenExchangeError carrying the stringified message', async () => {
    const api = getShopifyApiInstance();
    vi.spyOn(api.auth, 'tokenExchange').mockRejectedValue('plain-string-throw');

    try {
      await tokenExchangeForShop({
        shop: SHOP,
        sessionToken: FAKE_JWT,
      });
      throw new Error('expected ShopifyTokenExchangeError');
    } catch (err) {
      expect(err).toBeInstanceOf(ShopifyTokenExchangeError);
      expect((err as ShopifyTokenExchangeError).message).toContain(
        'plain-string-throw',
      );
    }
  });
});
