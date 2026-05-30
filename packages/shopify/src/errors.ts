import { AppError, IntegrationError } from '@winback/errors';

/**
 * HMAC verification failed on a Shopify-originated request (OAuth callback
 * or webhook). The request must be rejected at the boundary BEFORE any DB
 * access — see the ordering invariant documented in package README and
 * MIGRATIONS.md. P1 if a verified-by-Shopify request is rejected for HMAC;
 * P0 if an unverified request reaches handler code.
 */
export class ShopifyHmacError extends AppError {
  override readonly name = 'ShopifyHmacError';
  constructor(message: string, options: { cause?: unknown } = {}) {
    super({
      code: 'shopify.hmac_invalid',
      message,
      statusCode: 401,
      retryable: false,
      exposeMessage: false,
      cause: options.cause,
    });
  }
}

export class ShopifyInvalidShopError extends AppError {
  override readonly name = 'ShopifyInvalidShopError';
  constructor(shop: string) {
    super({
      code: 'shopify.invalid_shop',
      message: `Invalid shop domain: ${shop}`,
      statusCode: 400,
      retryable: false,
      exposeMessage: false,
      context: { shop },
    });
  }
}

export class ShopifyTokenExchangeError extends IntegrationError {
  override readonly name = 'ShopifyTokenExchangeError';
  constructor(
    message: string,
    options: { providerStatus?: number; cause?: unknown } = {},
  ) {
    super(message, {
      code: 'shopify.token_exchange_failed',
      provider: 'shopify',
      providerStatus: options.providerStatus,
      retryable: false, // OAuth codes are single-use; retry-with-same-code never works
      cause: options.cause,
    });
  }
}

/**
 * Session-token JWT verification failed (M-8). Used at the entry of
 * every authenticated route that runs post-managed-install: the App
 * Bridge session token is the auth credential, and a malformed /
 * forged / expired / wrong-shop token must be rejected at the boundary.
 *
 * The `reason` field carries the failure class for operator triage:
 *
 *   - 'invalid_jwt'    — SDK's `decodeSessionToken` rejected (bad
 *                        HS256 signature, malformed JWT structure,
 *                        expired `exp`, future `nbf` outside 10s
 *                        tolerance — see SDK's jose.jwtVerify wrapper).
 *   - 'wrong_audience' — `aud` claim doesn't match our SHOPIFY_API_KEY.
 *                        SDK's `checkAudience: true` enforces this.
 *   - 'wrong_dest'     — `dest` claim doesn't match the expected shop
 *                        (cross-shop replay attempt — a JWT issued for
 *                        shop X presented to a route asking about shop Y).
 *   - 'wrong_issuer'   — `iss` claim doesn't match the expected shop.
 *                        Defense in depth over `dest`.
 *   - 'missing_claim'  — required claim (`dest` / `aud` / `iss`) absent
 *                        from a JWT that otherwise verified cryptographically.
 *                        Indicates a non-Shopify-standard token shape.
 */
export type ShopifySessionTokenErrorReason =
  | 'invalid_jwt'
  | 'wrong_audience'
  | 'wrong_dest'
  | 'wrong_issuer'
  | 'missing_claim';

export class ShopifySessionTokenError extends AppError {
  override readonly name = 'ShopifySessionTokenError';
  readonly reason: ShopifySessionTokenErrorReason;
  constructor(
    reason: ShopifySessionTokenErrorReason,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super({
      code: `shopify.session_token.${reason}`,
      message,
      statusCode: 401,
      retryable: false,
      exposeMessage: false,
      cause: options.cause,
    });
    this.reason = reason;
  }
}
