/**
 * GDPR adapter — the ONLY drainer module that imports the compliance
 * processors from `@winback/db`. Strict package-boundary adapter:
 *
 *   1. Narrow `row.payload: unknown` through the matching zod schema.
 *   2. Derive `shop` from the validated `payload.shop_domain`.
 *   3. Hand off to the compliance processor with its expected args.
 *
 * Zero business logic here. Every guarantee about tenant scope, audit
 * writes, cascade behaviour, and idempotency lives in
 * `packages/db/src/compliance/gdpr-processor.ts`. The processors open
 * their own `withTenantScope` / `withSystemScope` internally; this
 * adapter does NOT add an outer scope.
 *
 * Dispatcher ordering (see `../ordering.ts`):
 *   - gdpr.customer_data_requested / gdpr.customer_redacted — run inside
 *     the drainer tx. Throws bubble up → drainer markFailed.
 *   - gdpr.shop_redacted — MARK_BEFORE_INVOKE_EVENTS. Drainer marks
 *     processed before invoking; this handler runs OUT of drainer tx
 *     because the processor cascades the OutboxEvent row away.
 */

import {
  processCustomerDataRequest,
  processCustomerRedact,
  processShopRedact,
  type CustomerDataRequestPayload,
  type CustomerRedactPayload,
  type OutboxEventRow,
  type ShopRedactPayload,
} from '@winback/db';

import type { DrainerContext } from '../context.js';
import {
  customerDataRequestPayloadSchema,
  customerRedactPayloadSchema,
  shopRedactPayloadSchema,
} from '../payload-schemas.js';

// Zod's `.optional()` produces `T | undefined`; the existing TS
// interfaces in @winback/db use `field?: T` (no explicit | undefined),
// which under `exactOptionalPropertyTypes: true` differ. The shapes
// ARE compatible at runtime — zod validated. Cast at the boundary
// rather than mutate the type system.

export async function handleCustomerDataRequested(
  ctx: DrainerContext,
  row: OutboxEventRow,
): Promise<void> {
  const payload = customerDataRequestPayloadSchema.parse(row.payload);
  await processCustomerDataRequest({
    prisma: ctx.prisma,
    merchantId: row.merchantId,
    shop: payload.shop_domain,
    payload: payload as CustomerDataRequestPayload,
  });
}

export async function handleCustomerRedacted(
  ctx: DrainerContext,
  row: OutboxEventRow,
): Promise<void> {
  const payload = customerRedactPayloadSchema.parse(row.payload);
  await processCustomerRedact({
    prisma: ctx.prisma,
    merchantId: row.merchantId,
    shop: payload.shop_domain,
    payload: payload as CustomerRedactPayload,
  });
}

export async function handleShopRedacted(
  ctx: DrainerContext,
  row: OutboxEventRow,
): Promise<void> {
  const payload = shopRedactPayloadSchema.parse(row.payload);
  await processShopRedact({
    prisma: ctx.prisma,
    shop: payload.shop_domain,
    payload: payload as ShopRedactPayload,
  });
}
