/**
 * Unit tests for `getShopifyApiInstance` (M-8 Commit 1).
 *
 * Locks the two invariants documented in
 * `packages/shopify/src/auth/shopify-api-instance.ts`:
 *
 *   1. MEMOISATION. `getShopifyApiInstance()` returns the same
 *      `Shopify` reference across calls. Without this, a per-test
 *      `vi.spyOn(getShopifyApiInstance().auth, 'tokenExchange')`
 *      would not be observed by the wrappers (since they'd construct
 *      a fresh, un-spied instance internally).
 *
 *   2. DRIFT IMPOSSIBILITY between this module's instance and the
 *      `shopifyApp({...})` instance constructed independently in
 *      `apps/web/app/shopify.server.ts`. The argument is that BOTH
 *      pull from the same `getShopifyConfig()` singleton; we exercise
 *      this by constructing a parallel `shopifyApi({...})` instance
 *      from the SAME getShopifyConfig and asserting the SDK reads the
 *      same effective config back.
 *
 *      This is a defensive lock — if a future PR adds a config-read
 *      somewhere ELSE in this module (a hardcoded apiKey override,
 *      etc.), this test fails. The risk class it guards: "JWT verifier
 *      uses one apiSecret, Token Exchange uses another, App Bridge
 *      tokens silently fail to verify post-deploy."
 *
 *   3. The test reset hook actually resets — a fresh instance can be
 *      built from a new config source after `_resetShopifyApiInstanceForTests`.
 */

import {
  ApiVersion,
  LATEST_API_VERSION,
  LogSeverity,
  shopifyApi,
} from '@shopify/shopify-api';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetShopifyApiInstanceForTests,
  getShopifyApiInstance,
} from '../../src/auth/index.js';
import { getShopifyConfig, parseScopes } from '../../src/config.js';

const TEST_API_KEY = 'test-api-key-12345abcdef';
const TEST_API_SECRET =
  'test-api-secret-at-least-thirty-two-bytes-long-for-hmac-key-safety-OK';

const TEST_ENV: NodeJS.ProcessEnv = {
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

describe('getShopifyApiInstance — memoisation', () => {
  it('returns the same reference across calls (so vi.spyOn on the cached instance is observed by wrappers)', () => {
    const a = getShopifyApiInstance();
    const b = getShopifyApiInstance();
    expect(a).toBe(b);
    // Mutating a method on the cached instance is observed by the
    // next call — this is the load-bearing property for our test
    // pattern (spy on `api.auth.tokenExchange`).
    expect(a.auth).toBe(b.auth);
    expect(a.session).toBe(b.session);
  });

  it('_resetShopifyApiInstanceForTests forces a fresh instance on the next call', () => {
    const a = getShopifyApiInstance();
    _resetShopifyApiInstanceForTests();
    const b = getShopifyApiInstance();
    expect(a).not.toBe(b);
  });
});

describe('getShopifyApiInstance — drift impossibility vs apps/web shopifyApp instance', () => {
  /**
   * The argument: BOTH our instance and the `shopifyApp({...})`
   * instance in apps/web read from `getShopifyConfig()` at construction.
   * If we build a parallel `shopifyApi({...})` instance from the same
   * config, the SDK's effective config (apiKey, apiSecretKey,
   * apiVersion, scopes, hostName) MUST match. If this test fails, a
   * future PR has introduced a config-read divergence and the JWT
   * verifier vs Token Exchange paths can drift apart.
   */
  function buildParallelInstance(): ReturnType<typeof shopifyApi> {
    const config = getShopifyConfig();
    const recognized = Object.values(ApiVersion) as string[];
    const apiVersion = recognized.includes(config.SHOPIFY_API_VERSION)
      ? (config.SHOPIFY_API_VERSION as ApiVersion)
      : LATEST_API_VERSION;
    return shopifyApi({
      apiKey: config.SHOPIFY_API_KEY,
      apiSecretKey: config.SHOPIFY_API_SECRET,
      apiVersion,
      scopes: Array.from(parseScopes(config.SHOPIFY_SCOPES)),
      hostName: new URL(config.SHOPIFY_APP_URL).host,
      isEmbeddedApp: true,
      logger: { log: () => undefined, level: LogSeverity.Error },
    });
  }

  it('apiKey matches between our instance and a parallel SDK-constructed instance', () => {
    const ours = getShopifyApiInstance();
    const parallel = buildParallelInstance();
    expect(ours.config.apiKey).toBe(parallel.config.apiKey);
    expect(ours.config.apiKey).toBe(TEST_API_KEY);
  });

  it('apiSecretKey matches (the JWT HMAC key)', () => {
    const ours = getShopifyApiInstance();
    const parallel = buildParallelInstance();
    expect(ours.config.apiSecretKey).toBe(parallel.config.apiSecretKey);
    expect(ours.config.apiSecretKey).toBe(TEST_API_SECRET);
  });

  it('apiVersion matches', () => {
    const ours = getShopifyApiInstance();
    const parallel = buildParallelInstance();
    expect(ours.config.apiVersion).toBe(parallel.config.apiVersion);
  });

  it('hostName matches', () => {
    const ours = getShopifyApiInstance();
    const parallel = buildParallelInstance();
    expect(ours.config.hostName).toBe(parallel.config.hostName);
    expect(ours.config.hostName).toBe('test.invalid');
  });

  it('isEmbeddedApp matches (true)', () => {
    const ours = getShopifyApiInstance();
    const parallel = buildParallelInstance();
    expect(ours.config.isEmbeddedApp).toBe(parallel.config.isEmbeddedApp);
    expect(ours.config.isEmbeddedApp).toBe(true);
  });

  it('scopes match (set equality, order-independent)', () => {
    const ours = getShopifyApiInstance();
    const parallel = buildParallelInstance();
    const oursScopes = new Set(ours.config.scopes?.toArray() ?? []);
    const parallelScopes = new Set(parallel.config.scopes?.toArray() ?? []);
    expect(oursScopes).toEqual(parallelScopes);
    expect(oursScopes).toEqual(new Set(['read_customers', 'read_orders']));
  });
});
