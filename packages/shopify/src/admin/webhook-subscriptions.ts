import { WEBHOOK_TOPIC_TO_EVENT } from '../webhook-topics.js';
import type { AdminClient } from './client.js';

/**
 * Topic strings (as Shopify expects in GraphQL — UPPER_SNAKE_CASE).
 * Shopify's GraphQL `WebhookSubscriptionTopic` enum names differ from
 * the topic strings sent in webhook delivery headers.
 *
 * Example: webhook header `X-Shopify-Topic: customers/create`
 *          GraphQL enum:                 `CUSTOMERS_CREATE`
 */
function topicHeaderToGraphqlEnum(topic: string): string {
  return topic.toUpperCase().replaceAll('/', '_');
}

const SUBSCRIBE_MUTATION = `
  mutation Subscribe($topic: WebhookSubscriptionTopic!, $url: URL!) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: { callbackUrl: $url, format: JSON }
    ) {
      userErrors { field message }
      webhookSubscription { id }
    }
  }
`;

interface SubscribeResponse {
  webhookSubscriptionCreate?: {
    userErrors?: Array<{ field?: string[]; message: string }>;
    webhookSubscription?: { id: string } | null;
  };
}

export interface SubscribeResult {
  readonly topic: string;
  readonly subscriptionId: string | null;
  readonly errors: ReadonlyArray<{ field?: string[]; message: string }>;
}

// GDPR mandatory compliance webhooks (customers/data_request,
// customers/redact, shop/redact) are NOT registered here. They are
// declared at app level via Partners Dashboard → App Settings →
// Compliance Webhooks. Attempting to register them via
// webhookSubscriptionCreate produces a GraphQL enum error because
// these topics are not valid values for WebhookSubscriptionTopic.
// GDPR_TOPIC_TO_EVENT is still used by the receive path
// (webhook-ingest.server.ts) to route delivered webhooks to the
// correct outbox event type.
//
// (I-1 fix, 2026-05-23. See POINTS-TO-CONSIDER.md I-1 + OPERATIONS.md §4
// for the operator-side Partners Dashboard registration step that pairs
// with this code change.)

/**
 * Topics that LIVE IN `WEBHOOK_TOPIC_TO_EVENT` (so the receive path
 * can dispatch them) but are EXCLUDED from `subscribeAllWebhooks`
 * because their send-side registration via `webhookSubscriptionCreate`
 * is still being verified.
 *
 * Currently excluded: `app/scopes_update`.
 *
 * TODO M-9 follow-up: verify `APP_SCOPES_UPDATE` is a valid value of
 * the Shopify `WebhookSubscriptionTopic` GraphQL enum on the dev
 * store before enabling subscription via `webhookSubscriptionCreate`.
 * Until verified, this topic is excluded to avoid the I-1 class of
 * enum-rejection install failures (subscribing to an invalid enum
 * value bricks the install loop — the receive path treats every
 * subscribe error as terminal). If verified valid → remove this
 * exclusion in a one-line follow-up PR. If verified invalid →
 * migrate this topic to the `shopify.app.toml`
 * `[[webhooks.subscriptions]]` block.
 *
 * NOT the same mechanism as the GDPR exclusion above (GDPR topics
 * live in a SEPARATE map, `GDPR_TOPIC_TO_EVENT`, and never enter
 * `WEBHOOK_TOPIC_TO_EVENT`). This Set covers topics that legitimately
 * need receive-side mapping but whose send-side registration is
 * deliberately gated.
 */
export const SUBSCRIBE_EXCLUDED_TOPICS: ReadonlySet<string> = new Set([
  'app/scopes_update',
]);
/**
 * Subscribes all known commerce topics for a merchant to the given
 * callback URL. Idempotent at the Shopify side: subscribing an
 * already-subscribed topic with the same URL returns the existing
 * subscription.
 *
 * Per-topic failures are reported in the result; the function does NOT
 * throw on a single-topic failure. The caller decides whether partial
 * subscription is acceptable (typically: log + alert, retry in a
 * reconciliation worker).
 *
 * Webhook URL convention: `<SHOPIFY_APP_URL>/webhooks` — the single
 * dispatch endpoint from C3. Topic identity is carried in the
 * `X-Shopify-Topic` header at delivery time.
 *
 * Estimated cost ~10 per mutation. With 10 topics this is a small burst;
 * the cost tracker handles pacing if needed.
 */
export async function subscribeAllWebhooks(
  client: AdminClient,
  merchantId: string,
  callbackUrl: string,
): Promise<ReadonlyArray<SubscribeResult>> {
  const topics = Object.keys(WEBHOOK_TOPIC_TO_EVENT).filter(
    (topic) => !SUBSCRIBE_EXCLUDED_TOPICS.has(topic),
  );
  const results: SubscribeResult[] = [];
  for (const topic of topics) {
    const result = await subscribeOne(client, merchantId, topic, callbackUrl);
    results.push(result);
  }
  return results;
}

async function subscribeOne(
  client: AdminClient,
  merchantId: string,
  topic: string,
  callbackUrl: string,
): Promise<SubscribeResult> {
  try {
    const data = await client.graphql<SubscribeResponse>(merchantId, {
      query: SUBSCRIBE_MUTATION,
      variables: {
        topic: topicHeaderToGraphqlEnum(topic),
        url: callbackUrl,
      },
      estimatedCost: 10,
    });
    const wrapper = data.webhookSubscriptionCreate ?? {};
    const userErrors = wrapper.userErrors ?? [];
    return {
      topic,
      subscriptionId: wrapper.webhookSubscription?.id ?? null,
      errors: userErrors,
    };
  } catch (err) {
    return {
      topic,
      subscriptionId: null,
      errors: [{ message: err instanceof Error ? err.message : String(err) }],
    };
  }
}
