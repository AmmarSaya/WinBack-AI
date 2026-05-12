import { type LoaderFunctionArgs, redirect } from '@remix-run/node';
import { getLogger } from '@winback/logger';
import {
  buildAuthRedirectUrl,
  getShopifyConfig,
  isValidShopDomain,
} from '@winback/shopify';

import { generateState } from '~/services/auth-state.server.js';
import { withRequest } from '~/services/request-context.server.js';

const log = getLogger('web.auth.initiate');

/**
 * `/auth?shop=<shop>.myshopify.com`
 *
 * Initiates the OAuth flow:
 *   1. Validate shop domain (reject 400 if malformed — never hit Shopify
 *      with an unvalidated shop).
 *   2. Generate a random CSRF state + signed cookie.
 *   3. Redirect the browser to Shopify's authorize URL with the state.
 *
 * No DB access in this route. Pure URL composition.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return withRequest(request, async () => {
    const url = new URL(request.url);
    const shop = url.searchParams.get('shop');

    if (shop === null || !isValidShopDomain(shop)) {
      log.warn({ shop }, 'auth: invalid shop param');
      throw new Response('Invalid shop parameter', { status: 400 });
    }

    const config = getShopifyConfig();
    const { state, cookieHeader } = generateState(shop, config.SHOPIFY_API_SECRET);
    const authUrl = buildAuthRedirectUrl({ shop, state }, config);

    log.info({ shop }, 'auth: redirecting to Shopify');
    return redirect(authUrl, { headers: { 'Set-Cookie': cookieHeader } });
  });
}
