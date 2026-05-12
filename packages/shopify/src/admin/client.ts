import { RateLimitError } from '@winback/errors';
import { getLogger } from '@winback/logger';

import { type ShopifyConfig, getShopifyConfig } from '../config.js';
import type { CostTracker } from './cost-tracker.js';
import { ShopifyAdminApiError, ShopifyTokenRevokedError } from './errors.js';
import type { ShopifyTokenResolver } from './token-resolver.js';
import type { ThrottleStatus } from './types.js';

const log = getLogger('shopify.admin.client');

export interface AdminClientOptions {
  /** Default 3. Each retry waits per backoff/Retry-After. */
  readonly maxRetries?: number;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchFn?: typeof fetch;
  /** Injectable for tests; defaults to real `setTimeout`. */
  readonly sleepFn?: (ms: number) => Promise<void>;
}

export interface GraphQLArgs {
  readonly query: string;
  readonly variables?: Record<string, unknown>;
  /**
   * Pre-flight cost hint so we can wait BEFORE issuing a known-expensive
   * query. Default 50 (matches Shopify's "cheap" baseline).
   */
  readonly estimatedCost?: number;
}

export interface GraphQLResponse<T> {
  readonly data?: T;
  readonly errors?: Array<{
    message: string;
    extensions?: Record<string, unknown>;
  }>;
  readonly extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number;
      throttleStatus: ThrottleStatus;
    };
  };
}

const DEFAULT_ESTIMATED_COST = 50;
const DEFAULT_MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 8_000;

/**
 * Shopify Admin GraphQL client.
 *
 * **TOKEN BOUNDARY** (C4 standing rule): the public method `graphql` takes
 * `merchantId` — there is no `accessToken` parameter anywhere in this
 * class's surface. The TokenResolver is injected at construction; callers
 * cannot route around it because the type system rejects an
 * `accessToken` argument that doesn't exist in the signature. A future
 * developer who tries to "just pass the token" has nowhere in the API
 * to put it.
 *
 * Every call:
 *   1. Resolves merchantId → (shop, decrypted token) via the resolver.
 *   2. Waits via CostTracker if the shop's bucket can't fit the query.
 *   3. Reserves cost optimistically.
 *   4. Issues fetch to https://<shop>/admin/api/<version>/graphql.json.
 *   5. On 401 → marks revoked + throws ShopifyTokenRevokedError.
 *   6. On 429 / GraphQL THROTTLED → CostTracker.onThrottled + retry.
 *   7. On success → CostTracker.onResponse with authoritative throttleStatus.
 *
 * `retryable` classification follows our error taxonomy: network + 5xx +
 * 429 are retryable; 401 and 4xx with GraphQL non-throttle errors are
 * terminal.
 */
export class AdminClient {
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(
    private readonly resolver: ShopifyTokenResolver,
    private readonly costTracker: CostTracker,
    options: AdminClientOptions = {},
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleepFn = options.sleepFn ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async graphql<T = unknown>(
    merchantId: string,
    args: GraphQLArgs,
    config: ShopifyConfig = getShopifyConfig(),
  ): Promise<T> {
    const resolved = await this.resolver.getOfflineToken(merchantId);
    if (resolved === null) {
      throw new ShopifyTokenRevokedError(
        `No usable offline token for merchant ${merchantId}`,
      );
    }
    const { shop, accessToken } = resolved;
    const estimatedCost = args.estimatedCost ?? DEFAULT_ESTIMATED_COST;
    const url = `https://${shop}/admin/api/${config.SHOPIFY_API_VERSION}/graphql.json`;

    let attempt = 0;
    while (true) {
      const wait = this.costTracker.msUntilAvailable(shop, estimatedCost);
      if (wait > 0) {
        log.debug({ shop, wait, attempt }, 'admin: waiting for rate-limit budget');
        await this.sleepFn(wait);
      }
      this.costTracker.reserve(shop, estimatedCost);

      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Shopify-Access-Token': accessToken,
          },
          body: JSON.stringify({
            query: args.query,
            variables: args.variables ?? {},
          }),
        });
      } catch (err) {
        if (attempt >= this.maxRetries) {
          throw new ShopifyAdminApiError(
            `Network error after ${String(attempt)} retries`,
            { cause: err },
          );
        }
        log.warn({ err, shop, attempt }, 'admin: network error, retrying');
        await this.sleepFn(backoffMs(attempt));
        attempt++;
        continue;
      }

      // 401 → token revoked. Terminal.
      if (response.status === 401) {
        await this.resolver.markTokenRevoked(merchantId);
        log.warn({ shop, merchantId }, 'admin: 401, token revoked');
        throw new ShopifyTokenRevokedError(
          `Merchant ${merchantId} returned 401 (token revoked)`,
        );
      }

      // 429 → throttled. Retry with Retry-After hint or backoff.
      if (response.status === 429) {
        this.costTracker.onThrottled(shop);
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        log.warn({ shop, attempt, retryAfterMs }, 'admin: 429 throttled');
        if (attempt >= this.maxRetries) {
          throw new RateLimitError(
            `Shopify Admin API throttled after ${String(attempt)} retries`,
            {
              code: 'shopify.rate_limited',
              retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
            },
          );
        }
        await this.sleepFn(retryAfterMs);
        attempt++;
        continue;
      }

      // Other non-2xx: integration error (retryable).
      if (!response.ok) {
        if (attempt >= this.maxRetries) {
          const bodyPrefix = await response.text().catch(() => '');
          throw new ShopifyAdminApiError(
            `Shopify Admin API returned ${String(response.status)}`,
            {
              providerStatus: response.status,
              context: { bodyPrefix: bodyPrefix.slice(0, 500) },
            },
          );
        }
        log.warn(
          { shop, attempt, status: response.status },
          'admin: non-2xx, retrying',
        );
        await this.sleepFn(backoffMs(attempt));
        attempt++;
        continue;
      }

      // 2xx — parse + handle GraphQL-level errors.
      let json: GraphQLResponse<T>;
      try {
        json = (await response.json()) as GraphQLResponse<T>;
      } catch (err) {
        throw new ShopifyAdminApiError('Admin API response not valid JSON', {
          cause: err,
        });
      }

      const throttleStatus = json.extensions?.cost?.throttleStatus;
      if (throttleStatus !== undefined) {
        this.costTracker.onResponse(shop, throttleStatus);
      }

      if (json.errors !== undefined && json.errors.length > 0) {
        const throttled = json.errors.find(
          (e) => (e.extensions as { code?: string } | undefined)?.code === 'THROTTLED',
        );
        if (throttled !== undefined) {
          this.costTracker.onThrottled(shop, throttleStatus);
          if (attempt >= this.maxRetries) {
            throw new RateLimitError('Shopify GraphQL THROTTLED', {
              code: 'shopify.rate_limited',
            });
          }
          log.warn({ shop, attempt }, 'admin: GraphQL THROTTLED, retrying');
          await this.sleepFn(backoffMs(attempt));
          attempt++;
          continue;
        }
        // Non-throttle GraphQL errors: terminal at this layer.
        throw new ShopifyAdminApiError(
          `GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`,
          { context: { errors: json.errors } },
        );
      }

      if (json.data === undefined) {
        throw new ShopifyAdminApiError('GraphQL response missing data field');
      }
      return json.data;
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  // Exponential with jitter: 500, 1000, 2000, 4000, 8000 cap; +0-250ms.
  const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250);
}

function parseRetryAfter(header: string | null): number {
  if (header === null) return 1000;
  const seconds = Number.parseFloat(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  return 1000;
}
