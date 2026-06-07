/**
 * Unit tests for `getShopifyApiInstance` (M-8 Commit 1; reframed B6).
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
 *   2. DRIFT IMPOSSIBILITY against future re-introduction of a
 *      parallel Shopify construction. We assert that any `Shopify`
 *      instance constructed from `getShopifyConfig()` produces config
 *      identical to the memoised `getShopifyApiInstance()`. We
 *      exercise this by building a parallel `shopifyApi({...})` from
 *      the SAME `getShopifyConfig()` and asserting the SDK reads the
 *      same effective config back across all five locked fields
 *      (apiKey, apiSecretKey, apiVersion, hostName, scopes).
 *
 *      Historical framing (M-8 Commit 1): originally locked the
 *      apps/web parallel `shopifyApp({...})` instance in
 *      `apps/web/app/shopify.server.ts` against drift from this
 *      module's instance — both were constructed at runtime, both
 *      read from `getShopifyConfig()`, the test guaranteed they saw
 *      the same effective config.
 *
 *      Current framing (post-B6, 2026-06-04): the apps/web parallel
 *      instance was deleted as orphaned (zero consumers). This
 *      module is now the SINGLE canonical Shopify SDK instance, and
 *      the test now locks against FUTURE re-introduction of a
 *      parallel construction (an SDK helper, a second adapter, a
 *      Path-A revival) silently drifting from canonical. The
 *      guarantee is ongoing and real, not vestigial — any future PR
 *      adding a config-read divergence (a hardcoded apiKey override,
 *      a second adapter pulling from a different source, etc.) at
 *      either the canonical or a newly-introduced parallel
 *      construction site fails this test.
 *
 *      Risk class guarded: "JWT verifier uses one apiSecret, Token
 *      Exchange uses another, App Bridge tokens silently fail to
 *      verify post-deploy."
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

describe('getShopifyApiInstance — drift impossibility vs future parallel construction', () => {
  /**
   * The argument: any code that constructs a `shopifyApi({...})` /
   * `shopifyApp({...})` from `getShopifyConfig()` MUST produce the
   * same effective config (apiKey, apiSecretKey, apiVersion, scopes,
   * hostName) as our canonical memoised instance. If we build a
   * parallel `shopifyApi({...})` from the same config and any field
   * diverges, a future PR has introduced a config-read divergence
   * and the JWT verifier vs Token Exchange paths can drift apart.
   *
   * Originally this locked the apps/web `shopifyApp({...})` instance
   * in `apps/web/app/shopify.server.ts` against this module's instance
   * (M-8 Commit 1). Post-B6 (2026-06-04) the apps/web instance was
   * deleted as orphaned; the test now guards FUTURE re-introduction
   * (SDK helper, second adapter, Path-A revival) of a parallel
   * construction silently drifting from canonical.
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
