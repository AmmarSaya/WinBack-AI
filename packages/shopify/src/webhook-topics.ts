import { OUTBOX_EVENTS, type OutboxEventType } from '@winback/contracts';

/**
 * Mapping from Shopify webhook topic strings (X-Shopify-Topic header) to
 * outbox event types in @winback/contracts.
 *
 * Two maps, one lookup surface:
 *
 *   - `WEBHOOK_TOPIC_TO_EVENT` — commerce + lifecycle topics. C3 ingestion
 *     emits these; consumers live in epics E/F/G.
 *   - `GDPR_TOPIC_TO_EVENT` — Shopify-mandatory GDPR topics. C3 ingestion
 *     emits these (since C6); the compliance processor in @winback/db
 *     consumes them, eventually invoked by D2.
 *
 * Topics NOT in either map fall back to:
 *   - Logged with errorCode='unknown_topic'. Likely indicates a webhook
 *     subscription that no longer corresponds to a known business event
 *     (Shopify added a topic we haven't mapped yet, or a misconfigured
 *     subscription). Operator alert, not a merchant error.
 *
 * Adding a topic means: (1) ensure the OutboxEvent type exists in
 * @winback/contracts, (2) add the row here, (3) extend the consumer in
 * the relevant epic (E for customer/order, F/G for downstream, @winback/db
 * compliance for GDPR).
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
 * GDPR mandatory webhook topics. Subscribing to all three is required for
 * Shopify app-store submission. Topic → outbox event mapping; the C6
 * compliance processor handles each event in @winback/db.
 *
 * Why a separate map: keeps `WEBHOOK_TOPIC_TO_EVENT` focused on commerce
 * topics (which dominate volume) and makes the GDPR set explicit at every
 * site that imports it — the topics get special treatment in tests, in
 * the subscribeAllWebhooks helper, and in compliance dashboards.
 */
export const GDPR_TOPIC_TO_EVENT: Readonly<Record<string, OutboxEventType>> = {
  'customers/data_request': OUTBOX_EVENTS.gdpr.customer_data_requested,
  'customers/redact': OUTBOX_EVENTS.gdpr.customer_redacted,
  'shop/redact': OUTBOX_EVENTS.gdpr.shop_redacted,
};

/**
 * Set view of GDPR topics. Used by callers that need to special-case the
 * GDPR flow (e.g. operator dashboards, compliance audits). NOT used by
 * the install-time `subscribeAllWebhooks` path — GDPR topics are declared
 * at app level via Partners Dashboard (see webhook-subscriptions.ts
 * header comment and OPERATIONS.md §4 for the operator step).
 */
export const GDPR_TOPICS: ReadonlySet<string> = new Set(Object.keys(GDPR_TOPIC_TO_EVENT));

export function getOutboxEventForTopic(topic: string): OutboxEventType | null {
  return WEBHOOK_TOPIC_TO_EVENT[topic] ?? GDPR_TOPIC_TO_EVENT[topic] ?? null;
}

export function isGdprTopic(topic: string): boolean {
  return topic in GDPR_TOPIC_TO_EVENT;
}

export function isKnownTopic(topic: string): boolean {
  return topic in WEBHOOK_TOPIC_TO_EVENT || topic in GDPR_TOPIC_TO_EVENT;
}
