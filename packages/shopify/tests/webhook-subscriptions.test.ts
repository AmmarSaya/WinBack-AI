import { describe, expect, it, vi } from 'vitest';

import type { AdminClient } from '../src/admin/client.js';
import {
  SUBSCRIBE_EXCLUDED_TOPICS,
  subscribeAllWebhooks,
} from '../src/admin/webhook-subscriptions.js';
import {
  GDPR_TOPIC_TO_EVENT,
  WEBHOOK_TOPIC_TO_EVENT,
} from '../src/webhook-topics.js';

/**
 * Convert a webhook header topic string (e.g. `customers/create`) to the
 * UPPER_SNAKE_CASE form Shopify's `WebhookSubscriptionTopic` GraphQL enum
 * expects (e.g. `CUSTOMERS_CREATE`). Mirrors the conversion in
 * `subscribeAllWebhooks` so the test asserts against the actual wire form.
 */
function headerToEnum(topic: string): string {
  return topic.toUpperCase().replaceAll('/', '_');
}

const GDPR_ENUM_VARIANTS = new Set(
  Object.keys(GDPR_TOPIC_TO_EVENT).map(headerToEnum),
);

// M-9: BUSINESS_ENUM_VARIANTS is the set of topics actually subscribed
// via `subscribeAllWebhooks` — derived from `WEBHOOK_TOPIC_TO_EVENT`
// minus `SUBSCRIBE_EXCLUDED_TOPICS`. The exclusion set currently holds
// `app/scopes_update` pending APP_SCOPES_UPDATE GraphQL-enum
// verification.
const BUSINESS_ENUM_VARIANTS = new Set(
  Object.keys(WEBHOOK_TOPIC_TO_EVENT)
    .filter((topic) => !SUBSCRIBE_EXCLUDED_TOPICS.has(topic))
    .map(headerToEnum),
);

const EXCLUDED_ENUM_VARIANTS = new Set(
  Array.from(SUBSCRIBE_EXCLUDED_TOPICS).map(headerToEnum),
);

function makeMockClient(): {
  client: AdminClient;
  graphqlSpy: ReturnType<typeof vi.fn>;
} {
  const graphqlSpy = vi.fn().mockResolvedValue({
    webhookSubscriptionCreate: {
      userErrors: [],
      webhookSubscription: { id: 'gid://shopify/WebhookSubscription/1' },
    },
  });
  // The function under test only ever invokes `client.graphql(...)`; a
  // hand-rolled stub avoids the heavyweight token-resolver + cost-tracker
  // construction a real AdminClient would need.
  const client = { graphql: graphqlSpy } as unknown as AdminClient;
  return { client, graphqlSpy };
}

describe('subscribeAllWebhooks (I-1 regression locks)', () => {
  const merchantId = 'merchant_test_cuid';
  const callbackUrl = 'https://winback-ai-web.onrender.com/webhooks';

  it('subscribes every business topic from WEBHOOK_TOPIC_TO_EVENT', async () => {
    const { client, graphqlSpy } = makeMockClient();

    const results = await subscribeAllWebhooks(client, merchantId, callbackUrl);

    expect(results).toHaveLength(BUSINESS_ENUM_VARIANTS.size);
    expect(graphqlSpy).toHaveBeenCalledTimes(BUSINESS_ENUM_VARIANTS.size);

    const subscribedEnumTopics = new Set(
      graphqlSpy.mock.calls.map(
        (call: unknown[]) =>
          ((call[1] as { variables: { topic: string } }).variables.topic),
      ),
    );

    // Every business topic the system knows about MUST be in the call set.
    // This is the regression lock against a future refactor that
    // accidentally drops one of the business topics from the loop.
    for (const expectedEnum of BUSINESS_ENUM_VARIANTS) {
      expect(subscribedEnumTopics.has(expectedEnum)).toBe(true);
    }
    expect(subscribedEnumTopics.size).toBe(BUSINESS_ENUM_VARIANTS.size);
  });

  it('does NOT attempt to subscribe any GDPR topic via webhookSubscriptionCreate (I-1)', async () => {
    const { client, graphqlSpy } = makeMockClient();

    await subscribeAllWebhooks(client, merchantId, callbackUrl);

    // GDPR topics are declared at app level (Partners Dashboard →
    // Compliance Webhooks). Attempting to subscribe them here produces
    // a GraphQL enum error because `customers/data_request` etc. are NOT
    // valid values for `WebhookSubscriptionTopic`. Empirically observed
    // in prod logs at 2026-05-22 20:34 UTC; full diagnosis in handoff.md
    // §Known bugs I-1.
    for (const call of graphqlSpy.mock.calls) {
      const variables = (call[1] as { variables: { topic: string } }).variables;
      expect(GDPR_ENUM_VARIANTS.has(variables.topic)).toBe(false);
    }
  });

  it('does NOT attempt to subscribe any topic in SUBSCRIBE_EXCLUDED_TOPICS (M-9 exclusion lock)', async () => {
    const { client, graphqlSpy } = makeMockClient();

    await subscribeAllWebhooks(client, merchantId, callbackUrl);

    // M-9: SUBSCRIBE_EXCLUDED_TOPICS currently holds `app/scopes_update`.
    // The topic IS in WEBHOOK_TOPIC_TO_EVENT (receive-side mapping for
    // dispatch routing) but MUST NOT be sent to webhookSubscriptionCreate
    // until APP_SCOPES_UPDATE is verified as a valid
    // WebhookSubscriptionTopic GraphQL enum value (same enum-rejection
    // risk class as I-1). If this lock fails, an unverified enum value
    // is being shipped to Shopify — exactly the bug the exclusion exists
    // to prevent.
    expect(SUBSCRIBE_EXCLUDED_TOPICS.has('app/scopes_update')).toBe(true);
    for (const call of graphqlSpy.mock.calls) {
      const variables = (call[1] as { variables: { topic: string } }).variables;
      expect(EXCLUDED_ENUM_VARIANTS.has(variables.topic)).toBe(false);
    }
  });

  it('passes the configured callbackUrl to every subscription', async () => {
    const { client, graphqlSpy } = makeMockClient();

    await subscribeAllWebhooks(client, merchantId, callbackUrl);

    for (const call of graphqlSpy.mock.calls) {
      const variables = (call[1] as { variables: { url: string } }).variables;
      expect(variables.url).toBe(callbackUrl);
    }
  });

  it('reports per-topic Shopify userErrors without throwing', async () => {
    const graphqlSpy = vi.fn().mockResolvedValue({
      webhookSubscriptionCreate: {
        userErrors: [{ field: ['webhookSubscription', 'callbackUrl'], message: 'taken' }],
        webhookSubscription: null,
      },
    });
    const client = { graphql: graphqlSpy } as unknown as AdminClient;

    const results = await subscribeAllWebhooks(client, merchantId, callbackUrl);

    // 10 business topics × 1 userError each = 10 result rows with errors.
    expect(results).toHaveLength(BUSINESS_ENUM_VARIANTS.size);
    for (const result of results) {
      expect(result.subscriptionId).toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toBe('taken');
    }
  });

  it('captures thrown errors per topic without aborting the loop', async () => {
    const graphqlSpy = vi.fn().mockRejectedValue(new Error('network down'));
    const client = { graphql: graphqlSpy } as unknown as AdminClient;

    const results = await subscribeAllWebhooks(client, merchantId, callbackUrl);

    expect(results).toHaveLength(BUSINESS_ENUM_VARIANTS.size);
    for (const result of results) {
      expect(result.subscriptionId).toBeNull();
      expect(result.errors[0]?.message).toBe('network down');
    }
  });
});
