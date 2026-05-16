import type { OutboxEventRow } from '@winback/db';
import { getLogger } from '@winback/logger';

import type { DrainerContext } from '../context.js';
import { orderEventPayloadSchema } from '../payload-schemas.js';

const log = getLogger('drainer.handler.order');

/**
 * Job payload format for `attribution.compute` queue.
 *
 * D2 LOCKS this shape — H1's attribution worker consumes it. Any
 * payload-shape change MUST bump the `attribution.compute@v<n>` version
 * suffix (CP-2 Q3 convention) and ship a coordinated H1 update.
 *
 * Current v1 carries:
 *   - merchantId: the tenant scope target for H1's drainer
 *   - orderId: the local cuid (NOT a Shopify GID) — what H1's qualifying-
 *     transition check reads from the Order table
 *   - eventType: 'order.placed' | 'order.updated' — H1 needs to know
 *     which qualifying-transition variant applies (Q1 of CP-2)
 *   - outboxEventId: forensic link back to the source row for log
 *     correlation
 */
export interface AttributionComputeJobPayloadV1 {
  readonly merchantId: string;
  readonly orderId: string;
  readonly eventType: 'order.placed' | 'order.updated';
  readonly outboxEventId: string;
}

/**
 * Handler for `order.placed` / `order.updated`. D2 STUB: enqueues a job
 * onto the `attribution.compute` queue. H1 ships the consumer Worker
 * that reads these jobs and writes `AttributionEvent` rows per the
 * CP-2 qualifying-transition rules.
 *
 * Per CP-2 carry-forward: `attribution.compute` runs with a lower
 * BullMQ priority + separate concurrency budget than `outbox.drain`,
 * so heavy attribution computation cannot starve order ingestion.
 * That worker config lives at H1's Worker construction site, not here.
 */
export async function handleOrderEvent(
  ctx: DrainerContext,
  row: OutboxEventRow,
  eventType: 'order.placed' | 'order.updated',
): Promise<void> {
  const payload = orderEventPayloadSchema.parse(row.payload);

  const job: AttributionComputeJobPayloadV1 = {
    merchantId: row.merchantId,
    orderId: payload.orderId,
    eventType,
    outboxEventId: row.id,
  };

  await ctx.queues.attributionCompute.add('attribution.compute@v1', job);

  log.info(
    { eventId: row.id, merchantId: row.merchantId, orderId: payload.orderId, eventType },
    'attribution.compute job enqueued',
  );
}

/**
 * Handler for `order.cancelled` / `order.refunded`. Noop in D2.
 *
 * CP-2 Q2(d) handles refunds via marker fields on the existing
 * AttributionEvent row, written by H1's attribution worker when it
 * sees an `orders/updated` webhook transition to refunded. The
 * `order.refunded` outbox event itself is NOT the trigger for that
 * write — `orders/updated` with `financial_status: refunded` is.
 * (See CP2-ATTRIBUTION-CONTRACT.md §Q2d.)
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
