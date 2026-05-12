import { AppError, IntegrationError } from '@winback/errors';

/**
 * The merchant's offline token is gone (revoked at Shopify side, or our
 * Session row missing/decrypt-failed). Caller must stop trying to call
 * Shopify and surface a re-auth prompt.
 *
 * `retryable: false` — retrying with the same merchantId would just hit
 * 401 again until the merchant reinstalls.
 */
export class ShopifyTokenRevokedError extends AppError {
  override readonly name = 'ShopifyTokenRevokedError';
  constructor(message: string, options: { cause?: unknown } = {}) {
    super({
      code: 'shopify.token_revoked',
      message,
      statusCode: 401,
      retryable: false,
      exposeMessage: false,
      cause: options.cause,
    });
  }
}

/**
 * Generic Shopify Admin API failure (5xx, malformed response, GraphQL
 * error, etc.). Retryable by default — the request didn't succeed but
 * may succeed on retry. Specific subclasses (RateLimitError) are emitted
 * by the AdminClient for the cases where retry policy differs.
 */
export class ShopifyAdminApiError extends IntegrationError {
  override readonly name = 'ShopifyAdminApiError';
  constructor(
    message: string,
    options: {
      providerStatus?: number;
      cause?: unknown;
      context?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message, {
      code: 'shopify.admin_api_error',
      provider: 'shopify',
      providerStatus: options.providerStatus,
      retryable: true,
      cause: options.cause,
      context: options.context,
    });
  }
}
