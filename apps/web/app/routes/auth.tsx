import { type LoaderFunctionArgs, json, redirect } from '@remix-run/node';
import { getLogger } from '@winback/logger';
import {
  ShopifySessionTokenError,
  type ShopifyConfig,
  buildAdminClient,
  buildAuthRedirectUrl,
  completeInstall,
  decodeAndVerifySessionToken,
  getShopifyConfig,
  normalizeShopDomain,
  subscribeAllWebhooks,
  tokenExchangeForShop,
} from '@winback/shopify';

import { generateState } from '~/services/auth-state.server.js';
import { getPrisma } from '~/services/db.server.js';
import { withRequest } from '~/services/request-context.server.js';
import { getSessionStorage } from '~/services/session-storage.server.js';

const log = getLogger('web.auth');

/**
 * `/auth?shop=<shop>.myshopify.com [&id_token=<JWT>] [&host=<host>]`
 *
 * Two branches, distinguished by `id_token` presence:
 *
 * ── BRANCH A: id_token PRESENT (M-8 Token Exchange bootstrap) ──
 *   1. Decode + verify session-token JWT (HS256 + dest + iss + aud).
 *   2. Token Exchange → offline access token + scope.
 *   3. completeInstall (atomic Merchant + Settings + Subscription + outbox).
 *   4. storeSession (encrypted access token persisted).
 *   5. IF first install: subscribeAllWebhooks. (Re-bootstraps skip — the
 *      M-9 `app/scopes_update` webhook handles scope drift; webhook
 *      subscription drift is reconciled elsewhere.)
 *   6. Redirect 302 → /?shop=...[&host=...]
 *
 *   Failure mapping (per Phase 1 Q-A1..Q-A4):
 *     - Step 1 fail → 401 JSON `{ error: 'session_token_invalid',
 *                                  reason: <discriminator> }`
 *     - Step 2 fail → 500 JSON `{ error, retry: true }` + Retry-After: 1
 *     - Step 3 fail → 500 JSON same shape. completeInstall is idempotent;
 *                     retry recovers. Orphan-Merchant risk is acceptable
 *                     (Q-A4).
 *     - Step 4 fail → 500 JSON same shape.
 *     - Step 5 fail → 302 → /?shop=...[&host=...] (Q-A1: NOT /auth — avoids
 *                     managed-install merchants falling into code-grant
 *                     regression). Merchant + Session rows are already
 *                     persisted; webhook reconciliation runs separately.
 *
 * ── BRANCH B: id_token ABSENT (legacy code-grant initiator) ──
 *   Preserved verbatim from the pre-M-8 behavior. Generates a CSRF state
 *   cookie + redirects to Shopify's `/admin/oauth/authorize`. The
 *   `/auth.callback.tsx` route completes that flow. Coexistence
 *   invariant: this path MUST remain functional until the legacy
 *   code-grant flow is decommissioned in a separate session.
 *
 * NO DB access in Branch B. Branch A opens the (system-scoped) install
 * transaction inside `completeInstall` and writes the encrypted Session
 * via the storage adapter.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return withRequest(request, async () => {
    const url = new URL(request.url);
    const shopParam = url.searchParams.get('shop');
    const idToken = url.searchParams.get('id_token');
    const host = url.searchParams.get('host');

    // normalizeShopDomain validates + canonicalizes (lowercase) in one step.
    // Same pattern as the legacy initiator + the callback route; persisting
    // by the canonical form keeps install / webhook / operator-tool lookups
    // aligned regardless of how the merchant navigated here.
    const shop = shopParam !== null ? normalizeShopDomain(shopParam) : null;
    if (shop === null) {
      log.warn({ shop: shopParam }, 'auth: invalid shop param');
      throw new Response('Invalid shop parameter', { status: 400 });
    }

    const config = getShopifyConfig();

    if (idToken !== null && idToken.length > 0) {
      return await runTokenExchangeBootstrap({ shop, idToken, host, config });
    }

    return runCodeGrantInitiator({ shop, config });
  });
}

// ===========================================================================
// Branch A — Token Exchange bootstrap (M-8)
// ===========================================================================

interface BootstrapArgs {
  readonly shop: string;
  readonly idToken: string;
  readonly host: string | null;
  readonly config: ShopifyConfig;
}

async function runTokenExchangeBootstrap(args: BootstrapArgs): Promise<Response> {
  const { shop, idToken, host, config } = args;

  // -----------------------------------------------------------------------
  // Comment 2 — Bounded-replay-window security property
  //
  // A session-token JWT verified here is a bearer credential for the
  // ~60s window between issue and `exp`. If an attacker captures one
  // during that window (XSS in an admin extension, network proxy
  // misconfiguration, etc.) they can replay it against this route up
  // until `exp`. The damage ceiling is bounded because:
  //
  //   - completeInstall is idempotent (upsert on Merchant.shop unique
  //     index — same shop → same merchantId, same Settings row, same
  //     BillingSubscription row).
  //   - storeSession writes are last-write-wins on `Session.id =
  //     offline_<shop>`. A replay just refreshes the encrypted access
  //     token to whatever Token Exchange returns this time (Shopify's
  //     own response, not attacker-controlled).
  //   - subscribeAllWebhooks is idempotent at Shopify's side (same
  //     callbackUrl + topic returns the existing subscription).
  //
  // Net: a replayed JWT can cause a redundant Token Exchange + redundant
  // upserts. No state corruption, no cross-tenant leak, no token
  // disclosure (the encrypted column never leaves the DB in clear).
  // The 60s window is enforced by the SDK's `exp` check (+ 10s clock
  // tolerance); we do not need a per-jti replay cache.
  // -----------------------------------------------------------------------
  let decoded;
  try {
    decoded = await decodeAndVerifySessionToken(idToken, shop);
  } catch (err) {
    if (err instanceof ShopifySessionTokenError) {
      log.warn(
        { shop, reason: err.reason },
        'auth: session-token verification failed',
      );
      return json(
        { error: 'session_token_invalid', reason: err.reason },
        { status: 401 },
      );
    }
    log.error({ err, shop }, 'auth: unexpected session-token decode error');
    return json(
      { error: 'session_token_invalid', reason: 'invalid_jwt' },
      { status: 401 },
    );
  }
  void decoded; // payload not needed downstream; verification was the point.

  let exchange;
  try {
    exchange = await tokenExchangeForShop({ shop, sessionToken: idToken });
  } catch (err) {
    log.error({ err, shop }, 'auth: token exchange failed');
    return json(
      { error: 'token_exchange_failed', retry: true },
      { status: 500, headers: { 'Retry-After': '1' } },
    );
  }

  const newSession = exchange.session;
  const newScope = newSession.scope ?? '';
  const accessToken = newSession.accessToken ?? '';

  // Scope-drift log (Q-A2 informational). Best-effort load of the prior
  // Session — failure here doesn't block the bootstrap. We do NOT re-invoke
  // subscribeAllWebhooks on drift: that's the M-9 `app/scopes_update`
  // webhook's job.
  await logScopeDriftIfAny(shop, newScope);

  // Q-A5: completeInstall BEFORE storeSession. Same order as code-grant.
  let install;
  try {
    install = await completeInstall(getPrisma(), {
      shop,
      accessToken,
      scope: newScope,
    });
  } catch (err) {
    log.error({ err, shop }, 'auth: completeInstall failed');
    return json(
      { error: 'install_failed', retry: true },
      { status: 500, headers: { 'Retry-After': '1' } },
    );
  }

  try {
    await getSessionStorage().storeSession(newSession);
  } catch (err) {
    log.error(
      { err, shop, merchantId: install.merchantId },
      'auth: storeSession failed',
    );
    return json(
      { error: 'session_store_failed', retry: true },
      { status: 500, headers: { 'Retry-After': '1' } },
    );
  }

  if (install.isNewInstall) {
    // ---------------------------------------------------------------------
    // Comment 1 — webhookSubscriptionCreate idempotency
    //
    // Shopify's `webhookSubscriptionCreate` mutation returns the EXISTING
    // subscription when called for an (apiClient, topic, callbackUrl)
    // triple that already has one — no duplicate subscription is created
    // and `userErrors` is empty. This makes concurrent first-install
    // bootstraps safe: if two parallel /auth?id_token requests both
    // observe `isNewInstall=true` (because the install upsert raced and
    // one of them won the "new install" branch), the second
    // subscribeAllWebhooks call no-ops at Shopify's side. We therefore
    // do NOT need our own dedup gate around this call; the idempotency
    // is provided by Shopify.
    //
    // Failure mode for the concurrent race is also benign: the second
    // call may see "already subscribed" surfaced as a non-error
    // existing-subscription return (no userErrors), or — depending on
    // Shopify's eventual consistency — as a temporary userError. The
    // M-10 webhook reconciliation cron heals either way.
    // ---------------------------------------------------------------------
    const subscribeRedirect = await trySubscribeAllWebhooks(
      shop,
      install.merchantId,
      config,
      host,
    );
    if (subscribeRedirect !== null) {
      return subscribeRedirect;
    }
  }

  log.info(
    {
      shop,
      merchantId: install.merchantId,
      isNewInstall: install.isNewInstall,
    },
    'auth: token-exchange bootstrap complete',
  );

  return redirectToAppRoot(shop, host, config);
}

async function logScopeDriftIfAny(shop: string, newScope: string): Promise<void> {
  try {
    const prior = await getSessionStorage().loadSession(`offline_${shop}`);
    if (prior !== undefined && prior !== null) {
      const priorScope = prior.scope ?? '';
      if (priorScope !== newScope) {
        log.info(
          { shop, priorScope, newScope },
          'auth: session scope drift detected',
        );
      }
    }
  } catch (err) {
    log.debug({ err, shop }, 'auth: prior session load failed (drift log skipped)');
  }
}

async function trySubscribeAllWebhooks(
  shop: string,
  merchantId: string,
  config: ShopifyConfig,
  host: string | null,
): Promise<Response | null> {
  try {
    const adminClient = buildAdminClient(getPrisma(), config);
    const callbackUrl = `${config.SHOPIFY_APP_URL}/webhooks`;
    const results = await subscribeAllWebhooks(adminClient, merchantId, callbackUrl);
    const failed = results.filter((r) => r.errors.length > 0);
    if (failed.length > 0) {
      log.error(
        { shop, merchantId, failed },
        'auth: webhook subscription returned userErrors — redirecting to app root',
      );
      return redirectToAppRoot(shop, host, config);
    }
    log.info(
      { shop, merchantId, count: results.length },
      'auth: webhooks subscribed',
    );
    return null;
  } catch (err) {
    log.error(
      { err, shop, merchantId },
      'auth: subscribeAllWebhooks threw — redirecting to app root',
    );
    return redirectToAppRoot(shop, host, config);
  }
}

function redirectToAppRoot(
  shop: string,
  host: string | null,
  config: ShopifyConfig,
): Response {
  // Q-A6: preserve `host` if present, omit if absent.
  const target = new URL('/', config.SHOPIFY_APP_URL);
  target.searchParams.set('shop', shop);
  if (host !== null && host.length > 0) {
    target.searchParams.set('host', host);
  }
  return redirect(target.toString());
}

// ===========================================================================
// Branch B — legacy code-grant initiator (preserved verbatim per Q-A7)
// ===========================================================================

interface CodeGrantArgs {
  readonly shop: string;
  readonly config: ShopifyConfig;
}

function runCodeGrantInitiator(args: CodeGrantArgs): Response {
  const { shop, config } = args;
  const { state, cookieHeader } = generateState(shop, config.SHOPIFY_API_SECRET);
  const authUrl = buildAuthRedirectUrl({ shop, state }, config);
  log.info({ shop }, 'auth: legacy code-grant initiator → Shopify');
  return redirect(authUrl, { headers: { 'Set-Cookie': cookieHeader } });
}
