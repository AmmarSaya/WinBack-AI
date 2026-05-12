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
