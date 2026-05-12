import { type LoaderFunctionArgs, redirect } from '@remix-run/node';
import { getLogger } from '@winback/logger';
import {
  completeInstall,
  exchangeCodeForToken,
  getShopifyConfig,
  isValidShopDomain,
  verifyShopifyOAuthHmac,
} from '@winback/shopify';

import { clearStateCookie, verifyState } from '~/services/auth-state.server.js';
import { getPrisma } from '~/services/db.server.js';
import { withRequest } from '~/services/request-context.server.js';
import { getSessionStorage } from '~/services/session-storage.server.js';

const log = getLogger('web.auth.callback');

/**
 * `/auth/callback?shop=...&code=...&state=...&hmac=...&host=...`
 *
 * Verification + install order (NEVER reorder):
 *
 *   1. Parse query params.
 *   2. Validate shop domain.
 *   3. Verify CSRF state cookie.   ← guardrail #3: before HMAC, before token
 *   4. Verify Shopify HMAC.
 *   5. Validate code.
 *   6. Exchange code for access token (HTTP to Shopify).
 *   7. completeInstall (atomic Merchant + Settings + Subscription + outbox).
 *   8. storeSession (encrypted access token).
 *   9. Redirect to embedded app.
 *
 * GUARDRAIL #1: a failure at step 6, 7, or 8 sends the merchant back through
 * `/auth?shop=...` — NEVER show a partial UI. Partial installs are worse
 * than no install (inconsistent state, merchant doesn't know why things
 * misbehave). The redirect restarts the flow cleanly.
 *
 * Step 3 + 4 failures: same redirect.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return withRequest(request, async () => {
    const url = new URL(request.url);
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) {
      query[k] = v;
    }

    const { shop, code, state, host } = query;

    // (2) shop validation — never hit Shopify with an unvalidated shop.
    if (shop === undefined || !isValidShopDomain(shop)) {
      log.warn({ shop }, 'callback: invalid shop');
      return new Response('Invalid shop', { status: 400 });
    }

    // (3) State BEFORE HMAC, BEFORE token exchange (guardrail #3).
    if (state === undefined || state.length === 0) {
      log.warn({ shop }, 'callback: missing state');
      return restartFlow(shop);
    }
    const config = getShopifyConfig();
    const stateResult = verifyState(
      request.headers.get('cookie'),
      state,
      shop,
      config.SHOPIFY_API_SECRET,
    );
    if (!stateResult.ok) {
      log.warn({ shop, reason: stateResult.reason }, 'callback: state verification failed');
      return restartFlow(shop);
    }

    // (4) HMAC verification.
    if (!verifyShopifyOAuthHmac(config.SHOPIFY_API_SECRET, query)) {
      log.warn({ shop }, 'callback: HMAC verification failed');
      // HMAC failure means the request wasn't issued by Shopify (or the
      // secret rotated mid-flight). Reject 401 explicitly — restarting via
      // /auth wouldn't change the outcome.
      return new Response('Invalid HMAC', { status: 401 });
    }

    // (5) code presence.
    if (code === undefined || code.length === 0) {
      log.warn({ shop }, 'callback: missing code');
      return restartFlow(shop);
    }

    // (6) Token exchange. Single-use code; failure is terminal for this
    // attempt, but the merchant can restart the flow.
    let tokenResult;
    try {
      tokenResult = await exchangeCodeForToken(shop, code, config);
    } catch (err) {
      log.error({ err, shop }, 'callback: token exchange failed — restarting flow');
      return restartFlow(shop);
    }

    // (7) completeInstall — guardrail #1. Any failure → restart, no partial UI.
    let installResult;
    try {
      installResult = await completeInstall(getPrisma(), {
        shop,
        accessToken: tokenResult.accessToken,
        scope: tokenResult.scope,
      });
    } catch (err) {
      log.error({ err, shop }, 'callback: completeInstall failed — restarting flow');
      return restartFlow(shop);
    }

    // (8) Session store — guardrail #1 continues. Without a session row,
    // the embedded app can't load. Hard failure → restart.
    try {
      await getSessionStorage().storeSession({
        id: `offline_${shop}`,
        shop,
        state,
        isOnline: false,
        scope: tokenResult.scope,
        accessToken: tokenResult.accessToken,
      });
    } catch (err) {
      log.error(
        { err, shop, merchantId: installResult.merchantId },
        'callback: session store failed — restarting flow',
      );
      return restartFlow(shop);
    }

    log.info(
      {
        shop,
        merchantId: installResult.merchantId,
        isNewInstall: installResult.isNewInstall,
      },
      'install completed',
    );

    // (9) Redirect to embedded app, preserving `host` for App Bridge.
    const target = new URL('/', config.SHOPIFY_APP_URL);
    target.searchParams.set('shop', shop);
    if (host !== undefined && host.length > 0) {
      target.searchParams.set('host', host);
    }
    return redirect(target.toString(), {
      // Clear the CSRF state cookie — install is complete, the state is
      // no longer needed and shouldn't be replayable.
      headers: { 'Set-Cookie': clearStateCookie() },
    });
  });
}

function restartFlow(shop: string): Response {
  const url = new URL(`/auth?shop=${encodeURIComponent(shop)}`, 'http://placeholder');
  return redirect(url.pathname + url.search, {
    headers: { 'Set-Cookie': clearStateCookie() },
  });
}
