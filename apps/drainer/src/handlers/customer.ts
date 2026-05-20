/**
 * Customer event handlers — `customers/create`, `customers/update`,
 * `customers/delete` (non-GDPR).
 *
 * Producer: apps/web/app/services/webhook-ingest.server.ts wraps the
 * Shopify customer webhook body in `{topic, webhookId, body}` per the
 * post-C-1 envelope shape. The handler:
 *   1. Validates the envelope + the Shopify body via
 *      `customerEventPayloadSchema` (which references the authoritative
 *      `shopifyCustomerWebhookBodySchema` in @winback/db).
 *   2. Opens `withTenantScope(row.merchantId)`.
 *   3. Opens `prisma.$transaction` and delegates to `CustomerRepository`.
 *
 * The drainer's per-row try/catch handles zod failures (markFailed) and
 * Prisma errors. ValidationError from the repository (malformed GID,
 * etc.) is non-retryable → markDeadLettered.
 *
 * GDPR `customers/redact` is a separate event (`gdpr.customer_redacted`)
 * handled in `./gdpr.ts` via the compliance processor — that path
 * permanently scrubs PII and emits its own AuditLog. The non-GDPR
 * `customers/delete` handled here only soft-deletes locally (sets
 * `deletedAt`) per the schema's soft-delete convention.
 */

import type { Prisma } from '@prisma/client';
import {
  CustomerRepository,
  type OutboxEventRow,
  toShopifyCustomerGid,
  withTenantScope,
} from '@winback/db';
import { ValidationError } from '@winback/errors';
import { getLogger } from '@winback/logger';

import type { DrainerContext } from '../context.js';
import { customerEventPayloadSchema } from '../payload-schemas.js';

const log = getLogger('drainer.handler.customer');

/**
 * Internal: both `customers/create` and `customers/update` webhooks
 * carry the same payload shape and we treat both as idempotent upserts.
 * The webhook topic distinguishes them but the handler logic is
 * identical (the upsert is idempotent on (merchantId, shopifyCustomerId)).
 * The `eventType` discriminator is kept for log clarity.
 */
async function runUpsert(
  ctx: DrainerContext,
  row: OutboxEventRow,
  eventType: 'customer.created' | 'customer.updated',
): Promise<void> {
  const payload = customerEventPayloadSchema.parse(row.payload);

  await withTenantScope(row.merchantId, async () => {
    const result = await ctx.prisma.$transaction(async (extendedTx) => {
      // Prisma 5 typing gap — same cast pattern as install.ts and the
      // drainer's $transaction wrapper.
      const tx = extendedTx as unknown as Prisma.TransactionClient;
      const repo = new CustomerRepository(ctx.prisma);
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
        customerId: result.customerId,
        isNewCustomer: result.isNewCustomer,
        shopifyWebhookId: payload.webhookId,
      },
      'customer upserted from webhook',
    );
  });
}

export async function handleCustomerCreated(
  ctx: DrainerContext,
  row: OutboxEventRow,
): Promise<void> {
  return runUpsert(ctx, row, 'customer.created');
}

export async function handleCustomerUpdated(
  ctx: DrainerContext,
  row: OutboxEventRow,
): Promise<void> {
  return runUpsert(ctx, row, 'customer.updated');
}

/**
 * `customers/delete` (non-GDPR). Soft-deletes the local Customer row by
 * setting `deletedAt`. Idempotent on already-deleted (existed: false).
 *
 * GDPR `customers/redact` is the permanent-PII-scrub variant handled
 * separately in `./gdpr.ts`.
 */
export async function handleCustomerDeleted(
  ctx: DrainerContext,
  row: OutboxEventRow,
): Promise<void> {
  const payload = customerEventPayloadSchema.parse(row.payload);

  const shopifyCustomerId = toShopifyCustomerGid(payload.body.id);
  if (shopifyCustomerId === null) {
    throw new ValidationError(`Customer delete webhook body.id is not a valid numeric id`, {
      code: 'customer.invalid_id',
      fields: { received: String(payload.body.id), eventId: row.id },
    });
  }

  await withTenantScope(row.merchantId, async () => {
    const result = await ctx.prisma.$transaction(async (extendedTx) => {
      const tx = extendedTx as unknown as Prisma.TransactionClient;
      const repo = new CustomerRepository(ctx.prisma);
      return repo.softDelete({
        merchantId: row.merchantId,
        shopifyCustomerId,
        tx,
      });
    });

    log.info(
      {
        eventId: row.id,
        merchantId: row.merchantId,
        shopifyCustomerId,
        existed: result.existed,
        shopifyWebhookId: payload.webhookId,
      },
      result.existed
        ? 'customer soft-deleted'
        : 'customer delete: already deleted or not present (idempotent no-op)',
    );
  });
}
