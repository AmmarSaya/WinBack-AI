import '@shopify/shopify-api/adapters/node';
import { ApiVersion, LATEST_API_VERSION } from '@shopify/shopify-api';
import { AppDistribution, shopifyApp } from '@shopify/shopify-app-remix/server';
import { getShopifyConfig, parseScopes } from '@winback/shopify';

import { getSessionStorage } from '~/services/session-storage.server.js';

/**
 * Shopify SDK + Remix-glue entry point (step 6 — Path A).
 *
 * Config is read EXCLUSIVELY through `getShopifyConfig()` from
 * `@winback/config`. No direct `process.env` reads here — that
 * convention is enforced across the workspace, and a new direct read
 * here would have been a regression.
 *
 * What we use this for (Path A scope):
 *   - The `shopifyApp` factory wires the SDK against our existing
 *     `EncryptedSessionStorage` decorator (which wraps the official
 *     Prisma session-storage adapter — see services/session-storage.server.ts).
 *   - The factory's other exports (authenticate.admin, authenticate.webhook,
 *     auth route handlers) are intentionally NOT used in step 6: our
 *     existing routes (auth.tsx, auth.callback.tsx, webhooks.tsx) own
 *     OAuth + webhook ingestion. The locked OAuth ordering invariants
 *     and the typed-event/outbox webhook pattern are preserved.
 *
 * SHOPIFY_API_VERSION comes from our config (default '2025-01' per the
 * schema). If the SDK doesn't recognize the literal as `ApiVersion`,
 * fall back to LATEST_API_VERSION — the SDK still accepts the raw
 * version string at the API call boundary.
 */
const config = getShopifyConfig();
const scopes = Array.from(parseScopes(config.SHOPIFY_SCOPES));

function resolveApiVersion(version: string): ApiVersion {
  // The SDK ships `ApiVersion` as a const enum of recognized quarters
  // (e.g. '2025-01', '2024-10'). If we pin to an older or newer quarter
  // not in the SDK's enum, fall back to LATEST_API_VERSION so the SDK
  // doesn't reject construction. The actual GraphQL request still uses
  // the version we configured via the AdminClient layer in @winback/shopify.
  const recognized = Object.values(ApiVersion) as string[];
  return recognized.includes(version)
    ? (version as ApiVersion)
    : LATEST_API_VERSION;
}

export const shopify = shopifyApp({
  apiKey: config.SHOPIFY_API_KEY,
  apiSecretKey: config.SHOPIFY_API_SECRET,
  apiVersion: resolveApiVersion(config.SHOPIFY_API_VERSION),
  scopes,
  appUrl: config.SHOPIFY_APP_URL,
  authPathPrefix: '/auth',
  isEmbeddedApp: true,
  distribution: AppDistribution.AppStore,
  sessionStorage: getSessionStorage(),
});
