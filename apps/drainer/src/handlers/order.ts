import type { OutboxEventRow } from '@winback/db';
import { getLogger } from '@winback/logger';

import type { DrainerContext } from '../context.js';
import { orderEventPayloadSchema } from '../payload-schemas.js';

const log = getLogger('drainer.handler.order');

/**
 * Handler for `order.placed` / `order.updated` outbox events.
 *
 * STUB — pre-Epic-E. Parses the producer-shaped payload (so a future
 * webhook-ingest shape change breaks loudly here, not silently downstream),
 * logs the receipt with the Shopify order id, and returns successfully.
 * No queue enqueue, no Order upsert, no attribution work.
 *
 * Real work lands in Epic E/H1 — see CP-2 §Q1. The drainer will upsert
 * the Order row, run the qualifying-transition check, and insert the
 * AttributionEvent inline in a single transaction. No separate consumer.
 *
 * History: pre-C1-fix this handler enqueued an `attribution.compute@v1`
 * job onto a BullMQ queue that had no consumer (H1 hadn't shipped), and
 * crucially the payload shape it expected (`{orderId}`) did not match
 * the producer (which writes `{topic, webhookId, body}`). Every real
 * Shopify order webhook would have failed the Zod parse and DLQ'd. The
 * mismatch hid because (a) drainer unit tests used fabricated payloads
 * matching the schema not the producer, and (b) there was no real-DB
 * integration test exercising ingest → drain → dispatch end-to-end.
 * The `attribution.compute` queue itself is removed in the same fix —
 * CP-2 §Q1 obsoleted the queue-and-consumer model in favor of inline
 * drainer work.
 */
export async function handleOrderEvent(
  ctx: DrainerContext,
  row: OutboxEventRow,
  eventType: 'order.placed' | 'order.updated',
): Promise<void> {
  // Silence the unused-parameter warning while keeping the ctx in the
  // signature — the real implementation in Epic E/H1 will read from
  // ctx.prisma to upsert Order and check the qualifying transition.
  void ctx;

  const payload = orderEventPayloadSchema.parse(row.payload);

  log.info(
    {
      eventId: row.id,
      merchantId: row.merchantId,
      eventType,
      topic: payload.topic,
      shopifyWebhookId: payload.webhookId,
      shopifyOrderId: payload.body.id ?? null,
    },
    'order event received (stub — Epic E/H1 will land real upsert + attribution)',
  );

  return Promise.resolve();
}

/**
 * Handler for `order.cancelled` / `order.refunded`. Noop pre-Epic-E.
 *
 * CP-2 Q2(d) handles refunds via marker fields on the existing
 * AttributionEvent row, written by H1's drainer logic when it sees an
 * `orders/updated` webhook transition to refunded. The `order.refunded`
 * outbox event itself is NOT the trigger for that write — `orders/updated`
 * with `financial_status: refunded` is.
 *
 * `order.cancelled` has no current consumer.
 */
export async function handleOrderNoop(row: OutboxEventRow): Promise<void> {
  log.debug(
    { eventId: row.id, type: row.type, merchantId: row.merchantId },
    'order event: no D2 handler (per CP-2 §Q2d for refunds)',
  );
  return Promise.resolve();
}
