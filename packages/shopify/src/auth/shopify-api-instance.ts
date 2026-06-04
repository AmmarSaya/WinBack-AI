/**
 * Internal `@shopify/shopify-api` `Shopify` instance, memoised per
 * process. The SDK's `tokenExchange` + `decodeSessionToken` helpers
 * are accessed via this instance's `.auth` + `.session` namespaces.
 *
 * This module owns the SINGLE canonical Shopify SDK instance for the
 * workspace.
 *
 * ─── WHY THIS MODULE OWNS THE CANONICAL INSTANCE ────────────────
 *
 * `@winback/shopify` needs to stand alone for non-Remix consumers —
 * the drainer + scheduler + future CLI never load Remix yet still
 * need access to the JWT verifier (for operator tooling, scope-update
 * reconciliation, etc.). An `apps/web`-owned SDK instance would
 * couple them to Remix.
 *
 * Historical note (B6 / 2026-06-04): `apps/web/app/shopify.server.ts`
 * previously constructed a second `shopifyApp({...})` instance from
 * `@shopify/shopify-app-remix` (M-8 Path A scaffolding). It was
 * deleted as orphaned — zero consumers, config validation + Node
 * adapter registration independently covered by
 * `apps/web/app/entry.server.tsx` (boot-time `getShopifyConfig()`)
 * and this module's adapter import (line below). Prior to deletion
 * the two instances coexisted; the drift test below originally
 * locked that pair against divergence.
 *
 * ─── DRIFT IMPOSSIBILITY (revised post-B6) ──────────────────────
 *
 * The drift-impossibility argument is locked by
 * `packages/shopify/tests/auth/shopify-api-instance.test.ts`. The 8
 * tests there assert that any `Shopify` instance constructed from
 * `getShopifyConfig()` produces config identical to the memoised
 * `getShopifyApiInstance()`.
 *
 * Originally this locked the apps/web parallel instance against
 * drift; post-M-8 / post-B6 there is a SINGLE canonical instance,
 * and the tests now lock against FUTURE re-introduction of a
 * parallel construction (an SDK helper, a second adapter, a Path-A
 * revival) silently drifting from canonical. The guarantee is
 * ongoing and real, not vestigial.
 *
 * `getShopifyConfig()` is itself memoised — first call validates
 * `process.env` against the Zod schema; subsequent calls return the
 * same singleton. Any future code that re-reads `getShopifyConfig()`
 * to construct a Shopify instance is therefore covered by the drift
 * test by construction — divergence only enters via a hardcoded
 * override at the construction site, which the test catches.
 *
 * Lifecycle: lazy-constructed on first call. Tests reset via
 * `_resetShopifyApiInstanceForTests()`. NO production runtime
 * override exists.
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
