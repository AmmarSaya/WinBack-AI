import { http, HttpResponse, type DefaultBodyType, type StrictRequest } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

/**
 * MSW server for intercepting outbound Shopify HTTP calls in integration
 * tests. Two endpoints are mocked:
 *
 *   1. OAuth token exchange — POST https://{shop}/admin/oauth/access_token
 *      Production: `tokenExchangeForShop` in @winback/shopify/auth/token-exchange.ts
 *      (RFC 8693 Token Exchange — the only path post-B4. The pre-B4
 *      code-grant `exchangeCodeForToken` posted to the same URL and was
 *      removed alongside the legacy auth path.)
 *
 *   2. Admin GraphQL — POST https://{shop}/admin/api/{version}/graphql.json
 *      Production: `AdminClient.graphql` in @winback/shopify/admin/client.ts.
 *      Used by `subscribeAllWebhooks` (13 mutations per install) and any
 *      future GraphQL caller (Epic E customer enrichment, Epic G campaigns).
 *
 * Defaults return success. Per-test overrides via `shopifyMockServer.use(...)`
 * for failure-path tests — see `mockTokenExchangeFailure` / `mockSubscribeFailure`
 * helpers below.
 *
 * `onUnhandledRequest: 'error'` so any forgotten Shopify call surfaces as a
 * test failure instead of a confusing real network attempt.
 */

const DEFAULT_TOKEN_RESPONSE = {
  access_token: 'shpat_test_token_for_harness',
  scope: 'read_customers,read_orders,write_discounts',
};

const DEFAULT_SUBSCRIBE_RESPONSE = {
  data: {
    webhookSubscriptionCreate: {
      userErrors: [],
      webhookSubscription: { id: 'gid://shopify/WebhookSubscription/100000000' },
    },
  },
};

export const shopifyMockServer = setupServer(
  http.post(
    'https://:shop/admin/oauth/access_token',
    () => HttpResponse.json(DEFAULT_TOKEN_RESPONSE),
  ),
  http.post(
    /https:\/\/[^/]+\/admin\/api\/[^/]+\/graphql\.json$/,
    () => HttpResponse.json(DEFAULT_SUBSCRIBE_RESPONSE),
  ),
);

/**
 * Wire MSW lifecycle into a describe block. Call once per test file that
 * touches Shopify HTTP. Resets handlers between tests so per-test overrides
 * don't leak.
 */
export function setupShopifyMocks(): void {
  beforeAll(() => { shopifyMockServer.listen({ onUnhandledRequest: 'error' }); });
  afterEach(() => { shopifyMockServer.resetHandlers(); });
  afterAll(() => { shopifyMockServer.close(); });
}

/**
 * Override: token exchange returns 401 (invalid/expired code). Used by the
 * "token exchange fails → restart flow" test.
 */
export function mockTokenExchangeFailure(): void {
  shopifyMockServer.use(
    http.post(
      'https://:shop/admin/oauth/access_token',
      () => new HttpResponse('invalid_request', { status: 401 }),
    ),
  );
}

/**
 * Override: webhook subscription returns a userErrors entry, simulating
 * Shopify rejecting one (or more) topic subscriptions. The route's
 * `subscribeAllWebhooks` aggregates per-topic results; ANY userErrors entry
 * triggers `restartFlow`. Used by the "subscribeAllWebhooks fails" test.
 */
export function mockSubscribeFailure(): void {
  shopifyMockServer.use(
    http.post(
      /https:\/\/[^/]+\/admin\/api\/[^/]+\/graphql\.json$/,
      async ({ request }: { request: StrictRequest<DefaultBodyType> }) => {
        // Inject failure on the FIRST mutation only so we see the route's
        // restart-flow path triggered by a single failing subscription
        // (matches production's "ANY failure → restart" semantics).
        const body = (await request.json()) as { query?: string };
        if (body.query?.includes('webhookSubscriptionCreate') === true) {
          return HttpResponse.json({
            data: {
              webhookSubscriptionCreate: {
                userErrors: [
                  { field: ['topic'], message: 'topic not supported (test fixture)' },
                ],
                webhookSubscription: null,
              },
            },
          });
        }
        return HttpResponse.json(DEFAULT_SUBSCRIBE_RESPONSE);
      },
    ),
  );
}
