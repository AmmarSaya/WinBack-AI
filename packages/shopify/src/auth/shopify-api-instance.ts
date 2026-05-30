/**
 * Internal `@shopify/shopify-api` `Shopify` instance, memoised per
 * process. The SDK's `tokenExchange` + `decodeSessionToken` helpers
 * are accessed via this instance's `.auth` + `.session` namespaces.
 *
 * ─── DESIGN DECISION: a SECOND `Shopify` instance? ──────────────
 *
 * `apps/web/app/shopify.server.ts` constructs a `shopifyApp({...})`
 * instance from `@shopify/shopify-app-remix`. That's the Remix
 * wrapper layer; it internally constructs its own `shopifyApi({...})`
 * instance. So in the web process at runtime, this module's instance
 * lives ALONGSIDE the one inside `shopifyApp` — two `Shopify` objects
 * holding the same config.
 *
 * We accept this duplication. Three reasons:
 *
 *   1. The `shopifyApp({...})` public TS type (`ShopifyAppBase` in
 *      `@shopify/shopify-app-remix/server/types.d.ts:214-377`) does
 *      NOT expose the underlying `Shopify` instance. The internal
 *      `BasicParams.api` field lives only on the SDK's private
 *      strategy/factory layer. Reading it via untyped runtime access
 *      would create a load-bearing dependency on SDK internals that
 *      breaks on every SDK upgrade.
 *
 *   2. `@winback/shopify` needs to stand alone for non-Remix
 *      consumers — the drainer + scheduler + future CLI never load
 *      Remix yet still need access to the JWT verifier (for future
 *      operator tooling, scope-update reconciliation, etc.). An
 *      `apps/web`-owned SDK instance would couple them to Remix.
 *
 *   3. Memory cost is trivial. A `Shopify` instance is a few config
 *      objects + bound helper functions — single-digit KB.
 *
 * ─── DRIFT IMPOSSIBILITY ────────────────────────────────────────
 *
 * Both instances read `getShopifyConfig()` at construction time.
 * `getShopifyConfig()` is itself memoised — first call validates
 * `process.env` against the Zod schema; subsequent calls return the
 * same singleton. Conclusion:
 *
 *   - Both instances see identical apiKey / apiSecretKey /
 *     apiVersion / scopes / hostName.
 *   - They cannot drift at runtime — `Shopify` config is frozen at
 *     construction; there's no setter.
 *   - The ONLY way to get different effective config is for one
 *     instance to be constructed BEFORE a
 *     `getShopifyConfig({reset: true, source: ...})` call and the
 *     other AFTER. Production code never calls reset. Tests reset
 *     ONLY in `beforeEach` (before either instance is constructed).
 *
 * The drift-impossibility argument is locked by
 * `packages/shopify/tests/auth/shopify-api-instance.test.ts` which
 * constructs both potential instances inline and compares config.
 *
 * Lifecycle: lazy-constructed on first call. Tests reset via
 * `_resetShopifyApiInstanceForTests()`. NO production runtime
 * override exists — see below.
 *
 * Adapter import is required at module top — Shopify's SDK ships
 * platform-specific adapters and the node adapter must be loaded
 * before any `shopifyApi({...})` construction.
 */

import '@shopify/shopify-api/adapters/node';
import {
  ApiVersion,
  LATEST_API_VERSION,
  LogSeverity,
  type Shopify,
  shopifyApi,
} from '@shopify/shopify-api';

import { getShopifyConfig, parseScopes } from '../config.js';

let cached: Shopify | null = null;

/**
 * The SDK ships `ApiVersion` as a const enum of recognised quarters.
 * If we pin to a quarter not in the enum (newer than the SDK we have),
 * fall back to LATEST_API_VERSION so construction succeeds — the
 * actual API version used by GraphQL calls is set per-client by
 * `@winback/shopify/admin/client.ts`, not by this instance.
 *
 * Same pattern as `apps/web/app/shopify.server.ts:resolveApiVersion`.
 */
function resolveApiVersion(version: string): ApiVersion {
  const recognized = Object.values(ApiVersion) as string[];
  return recognized.includes(version)
    ? (version as ApiVersion)
    : LATEST_API_VERSION;
}

export function getShopifyApiInstance(): Shopify {
  if (cached === null) {
    const config = getShopifyConfig();
    cached = shopifyApi({
      apiKey: config.SHOPIFY_API_KEY,
      apiSecretKey: config.SHOPIFY_API_SECRET,
      apiVersion: resolveApiVersion(config.SHOPIFY_API_VERSION),
      scopes: Array.from(parseScopes(config.SHOPIFY_SCOPES)),
      // hostName is required at construction. We derive from
      // SHOPIFY_APP_URL (e.g. https://winback-ai-web.onrender.com →
      // winback-ai-web.onrender.com). The SDK uses this for embedded
      // host validation; we don't currently exercise that path but the
      // value is needed for any future SDK helper that touches host.
      hostName: new URL(config.SHOPIFY_APP_URL).host,
      isEmbeddedApp: true,
      logger: {
        // No-op log function. The project's logger is `@winback/logger`;
        // the SDK's logger surface is silenced to avoid duplicate
        // structured-vs-plain-text output. SDK errors are still THROWN
        // through our wrappers (not just logged), so suppression is safe.
        log: () => undefined,
        level: LogSeverity.Error,
      },
    });
  }
  return cached;
}

/** Test seam. Production callers should not invoke. */
export function _resetShopifyApiInstanceForTests(): void {
  cached = null;
}
