import { OUTBOX_EVENTS, type OutboxEventType } from '@winback/contracts';

/**
 * Mapping from Shopify webhook topic strings (X-Shopify-Topic header) to
 * outbox event types in @winback/contracts.
 *
 * Topics NOT in this map fall into one of two buckets:
 *   - GDPR topics (see `GDPR_TOPICS`): logged to WebhookLog by the
 *     ingestion handler; processed by a dedicated compliance worker in C6.
 *     No outbox event at C3 — the event-type registry will add gdpr.*
 *     entries when C6 lands.
 *   - Unknown topics: logged with errorCode='unknown_topic'. Likely indicates
 *     a webhook subscription that no longer corresponds to a known
 *     business event (Shopify added a topic we haven't mapped yet, or a
 *     misconfigured subscription). Operator alert, not a merchant error.
 *
 * Adding a topic means: (1) ensure the OutboxEvent type exists in
 * @winback/contracts, (2) add the row here, (3) extend the consumer in
 * the relevant epic (E for customer/order, F/G for downstream).
 */
export const WEBHOOK_TOPIC_TO_EVENT: Readonly<Record<string, OutboxEventType>> = {
  'customers/create': OUTBOX_EVENTS.customer.created,
  'customers/update': OUTBOX_EVENTS.customer.updated,
  'customers/delete': OUTBOX_EVENTS.customer.deleted,
  'orders/create': OUTBOX_EVENTS.order.placed,
  'orders/updated': OUTBOX_EVENTS.order.updated,
  'orders/cancelled': OUTBOX_EVENTS.order.cancelled,
  'products/create': OUTBOX_EVENTS.product.created,
  'products/update': OUTBOX_EVENTS.product.updated,
  'products/delete': OUTBOX_EVENTS.product.deleted,
  'app/uninstalled': OUTBOX_EVENTS.merchant.uninstalled,
};

/**
 * GDPR mandatory webhook topics. Logged at C3; processed at C6. Subscribing
 * to these is required for Shopify app-store submission — see CP-1 review.
 */
export const GDPR_TOPICS: ReadonlySet<string> = new Set([
  'customers/data_request',
  'customers/redact',
  'shop/redact',
]);

export function getOutboxEventForTopic(topic: string): OutboxEventType | null {
  return WEBHOOK_TOPIC_TO_EVENT[topic] ?? null;
}

export function isGdprTopic(topic: string): boolean {
  return GDPR_TOPICS.has(topic);
}

export function isKnownTopic(topic: string): boolean {
  return topic in WEBHOOK_TOPIC_TO_EVENT || GDPR_TOPICS.has(topic);
}
