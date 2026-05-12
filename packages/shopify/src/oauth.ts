import { ValidationError } from '@winback/errors';
import { getLogger } from '@winback/logger';
import { z } from 'zod';

import { type ShopifyConfig, getShopifyConfig } from './config.js';
import { ShopifyInvalidShopError, ShopifyTokenExchangeError } from './errors.js';
import { isValidShopDomain } from './shop-domain.js';

const log = getLogger('shopify.oauth');

// ---------------------------------------------------------------------------
// Auth redirect URL
// ---------------------------------------------------------------------------

export interface AuthRedirectArgs {
  readonly shop: string;
  readonly state: string;
  /** Online vs offline access mode. C1 uses offline (long-lived) by default. */
  readonly online?: boolean;
}

/**
 * Builds the URL the merchant browser must be redirected to in order to
 * initiate Shopify OAuth. The caller (Remix route in C2) provides `state`
 * (a CSRF-protection nonce) which Shopify echoes back on callback.
 *
 * No HTTP request issued here — pure URL composition.
 */
export function buildAuthRedirectUrl(
  args: AuthRedirectArgs,
  config: ShopifyConfig = getShopifyConfig(),
): string {
  if (!isValidShopDomain(args.shop)) {
    throw new ShopifyInvalidShopError(args.shop);
  }
  const params = new URLSearchParams({
    client_id: config.SHOPIFY_API_KEY,
    scope: config.SHOPIFY_SCOPES,
    redirect_uri: `${config.SHOPIFY_APP_URL.replace(/\/$/, '')}/auth/callback`,
    state: args.state,
  });
  if (args.online === true) {
    params.set('grant_options[]', 'per-user');
  }
  return `https://${args.shop}/admin/oauth/authorize?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string(),
});

export interface TokenExchangeResult {
  readonly accessToken: string;
  readonly scope: string;
}

/**
 * Exchanges an OAuth `code` (received on the callback) for an access token.
 *
 * Network request issued. Failures:
 *   - Invalid shop → ShopifyInvalidShopError (no network call)
 *   - Non-2xx response → ShopifyTokenExchangeError (retryable=false: OAuth
 *     codes are single-use, the same code will never work again)
 *   - Malformed response body → ShopifyTokenExchangeError
 *
 * Callers MUST have verified the OAuth callback HMAC before calling this.
 */
export async function exchangeCodeForToken(
  shop: string,
  code: string,
  config: ShopifyConfig = getShopifyConfig(),
): Promise<TokenExchangeResult> {
  if (!isValidShopDomain(shop)) {
    throw new ShopifyInvalidShopError(shop);
  }
  if (typeof code !== 'string' || code.length === 0) {
    throw new ValidationError('OAuth code is required', { code: 'shopify.missing_code' });
  }

  const url = `https://${shop}/admin/oauth/access_token`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: config.SHOPIFY_API_KEY,
        client_secret: config.SHOPIFY_API_SECRET,
        code,
      }),
    });
  } catch (err) {
    log.error({ err, shop }, 'OAuth token exchange network failure');
    throw new ShopifyTokenExchangeError('OAuth token exchange request failed', {
      cause: err,
    });
  }

  if (!response.ok) {
    log.warn({ shop, status: response.status }, 'OAuth token exchange non-2xx');
    throw new ShopifyTokenExchangeError(
      `Shopify token exchange returned ${response.status}`,
      { providerStatus: response.status },
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (err) {
    throw new ShopifyTokenExchangeError('Token response not valid JSON', { cause: err });
  }

  const parsed = tokenResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new ShopifyTokenExchangeError('Token response shape unexpected', {
      cause: parsed.error,
    });
  }
  return { accessToken: parsed.data.access_token, scope: parsed.data.scope };
}
