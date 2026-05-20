import type { Prisma } from '@prisma/client';
import {
  AuditLogRepository,
  CustomerScoreRepository,
  CustomerScoreService,
  type OutboxEventRow,
  OrderRepository,
  type RecomputeResult,
  withTenantScope,
} from '@winback/db';
import { getLogger } from '@winback/logger';

import type { DrainerContext } from '../context.js';
import { orderEventPayloadSchema } from '../payload-schemas.js';

const log = getLogger('drainer.handler.order');

/**
 * Handler for `order.placed` / `order.updated` outbox events.
 *
 * Validates the producer-shaped payload via `orderEventPayloadSchema`
 * (which references the authoritative `shopifyOrderWebhookBodySchema`
 * in @winback/db).  Opens `withTenantScope(row.merchantId)` and
 * `prisma.$transaction`, then:
 *   1. `OrderRepository.upsertFromWebhook` — atomic Order + line items
 *      + CP-2 §Q1 qualifying-transition computation.
 *   2. If `result.customerId !== null` → `CustomerScoreService.recompute`
 *      inline in the same transaction (Epic E session 2 — RFM recompute
 *      + state-machine transition writes).  Guest-checkout orders
 *      (`customerId === null`) skip scoring per P-10.
 *
 * H1 will later add the AttributionEvent insert at the same call site
 * once the AttributionEvent table lands.  The qualifying-transition
 * result is logged today; H1 consumes it without a re-read.
 *
 * History — pre-Epic-E session 1 this handler was a stub (C-1 fix
 * removed the obsolete `attribution.compute` enqueue).  Batch 4 of
 * session 1 made it real; batch 4 of session 2 wires the scoring call.
 */
export async function handleOrderEvent(
  ctx: DrainerContext,
  row: OutboxEventRow,
  eventType: 'order.placed' | 'order.updated',
): Promise<void> {
  const payload = orderEventPayloadSchema.parse(row.payload);

  await withTenantScope(row.merchantId, async () => {
    const { upsert, scoring } = await ctx.prisma.$transaction(async (extendedTx) => {
      // Prisma 5 typing gap — same cast pattern as
      // apps/drainer/src/drainer.ts:119 and packages/shopify/src/install.ts:74.
      const tx = extendedTx as unknown as Prisma.TransactionClient;

      const orderRepo = new OrderRepository(ctx.prisma);
      const upsertResult = await orderRepo.upsertFromWebhook({
        merchantId: row.merchantId,
        body: payload.body,
        tx,
      });

      // Epic E session 2: inline RFM recompute for the associated customer.
      // Skipped when the order has no resolved customer (guest checkout
      // OR out-of-order delivery where the Customer row hasn't landed
      // yet — out-of-order is rare and the next customer.updated webhook
      // will trigger its own recompute).
      let scoringResult: RecomputeResult | null = null;
      if (upsertResult.customerId !== null) {
        const customerScoreRepo = new CustomerScoreRepository(ctx.prisma);
        const auditLogRepo = new AuditLogRepository(ctx.prisma);
        const scoringService = new CustomerScoreService(customerScoreRepo, auditLogRepo);
        scoringResult = await scoringService.recompute({
          merchantId: row.merchantId,
          customerId: upsertResult.customerId,
          tx,
        });
      }

      return { upsert: upsertResult, scoring: scoringResult };
    });

    log.info(
      {
        eventId: row.id,
        merchantId: row.merchantId,
        eventType,
        orderId: upsert.orderId,
        customerId: upsert.customerId,
        isNewOrder: upsert.isNewOrder,
        qualifyingTransition: upsert.qualifyingTransition,
        previousFinancialStatus: upsert.previousFinancialStatus,
        shopifyWebhookId: payload.webhookId,
        // Scoring observability per §S-10.  Null when guest checkout.
        scoring: scoring === null
          ? { skipped: 'no_customer' }
          : scoring.skipped !== null
            ? { skipped: scoring.skipped, cohortSize: scoring.cohortSize, durationMs: scoring.durationMs }
            : {
                branchTaken: scoring.branchTaken,
                stateChanged: scoring.stateChanged,
                previousState: scoring.previousState,
                newState: scoring.newState,
                cohortSize: scoring.cohortSize,
                durationMs: scoring.durationMs,
              },
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
