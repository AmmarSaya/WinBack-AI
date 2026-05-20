import type { Prisma } from '@prisma/client';
import { type OutboxEventRow, OrderRepository, withTenantScope } from '@winback/db';
import { getLogger } from '@winback/logger';

import type { DrainerContext } from '../context.js';
import { orderEventPayloadSchema } from '../payload-schemas.js';

const log = getLogger('drainer.handler.order');

/**
 * Handler for `order.placed` / `order.updated` outbox events.
 *
 * Validates the producer-shaped payload via `orderEventPayloadSchema`
 * (which references the authoritative `shopifyOrderWebhookBodySchema`
 * in @winback/db). Opens `withTenantScope(row.merchantId)` and
 * `prisma.$transaction`, then delegates to `OrderRepository.upsertFromWebhook`
 * for the atomic Order + OrderLineItem upsert + CP-2 §Q1 qualifying-
 * transition computation. The transition result is logged but NOT acted
 * on here — H1 will add the AttributionEvent insert inline at this same
 * call site once the AttributionEvent table lands.
 *
 * History — pre-Epic-E session 1 this handler was a documented stub
 * (C-1 fix removed the obsolete `attribution.compute` enqueue). Batch 4
 * of Epic E session 1 made it real.
 */
export async function handleOrderEvent(
  ctx: DrainerContext,
  row: OutboxEventRow,
  eventType: 'order.placed' | 'order.updated',
): Promise<void> {
  const payload = orderEventPayloadSchema.parse(row.payload);

  await withTenantScope(row.merchantId, async () => {
    const result = await ctx.prisma.$transaction(async (extendedTx) => {
      // Prisma 5 typing gap — same cast pattern as
      // apps/drainer/src/drainer.ts:119 and packages/shopify/src/install.ts:74.
      const tx = extendedTx as unknown as Prisma.TransactionClient;
      const repo = new OrderRepository(ctx.prisma);
      return repo.upsertFromWebhook({
        merchantId: row.merchantId,
        body: payload.body,
        tx,
      });
    });

    log.info(
      {
        eventId: row.id,
        merchantId: row.merchantId,
        eventType,
        orderId: result.orderId,
        isNewOrder: result.isNewOrder,
        qualifyingTransition: result.qualifyingTransition,
        previousFinancialStatus: result.previousFinancialStatus,
        shopifyWebhookId: payload.webhookId,
      },
      'order event processed',
    );
  });
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
