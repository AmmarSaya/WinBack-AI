/**
 * order.* stub handler tests.
 *
 * Pre-Epic-E, `handleOrderEvent` is a documented stub that validates the
 * producer-shaped payload (see handlers/order.ts header for the CP-2 §Q1
 * pointer) and logs receipt. These tests cover the validation surface +
 * the noop variants for cancelled/refunded.
 *
 * Real ingest → drain → dispatch coverage requires a real-DB drainer
 * integration harness — flagged in PRE-EPIC-E-AUDIT.md as the highest-
 * priority test-coverage gap. The producer-vs-consumer payload mismatch
 * that this stub replaced was exactly the bug class an integration test
 * would have caught.
 */

import type { OutboxEventRow } from '@winback/db';
import { describe, expect, it } from 'vitest';

import type { DrainerContext } from '../../src/context.js';
import { handleOrderEvent, handleOrderNoop } from '../../src/handlers/order.js';

function makeRow(type: string, payload: unknown): OutboxEventRow {
  return {
    id: 'row-' + type,
    merchantId: 'merchant-1',
    type,
    payload,
    createdAt: new Date(),
    attempts: 0,
    deadLetteredAt: null,
    deferredFailedAt: null,
  };
}

function makeCtx(): DrainerContext {
  return {
    prisma: {} as DrainerContext['prisma'],
    queues: {
      outboxDrain: {} as DrainerContext['queues']['outboxDrain'],
      cronRollup: {} as DrainerContext['queues']['cronRollup'],
      cronSweep: {} as DrainerContext['queues']['cronSweep'],
    },
    shopifyConfig: {} as DrainerContext['shopifyConfig'],
  };
}

/**
 * Generate a producer-shaped envelope + body that satisfies the post-Epic-E
 * session 1 `shopifyOrderWebhookBodySchema` (in @winback/shopify). All
 * required fields are populated with realistic minimums. Tests that want
 * to exercise specific MAPPED fields override via the `bodyOverrides`
 * parameter.
 */
function producerPayload(args: {
  topic: 'orders/create' | 'orders/updated';
  webhookId: string;
  shopifyOrderId: number | string;
  bodyOverrides?: Record<string, unknown>;
}): Record<string, unknown> {
  const moneySet = {
    shop_money: { amount: '0.00', currency_code: 'USD' },
    presentment_money: { amount: '0.00', currency_code: 'USD' },
  };
  const body = {
    id: args.shopifyOrderId,
    currency: 'USD',
    subtotal_price_set: moneySet,
    total_price_set: moneySet,
    total_tax_set: moneySet,
    total_discounts_set: moneySet,
    created_at: '2026-05-19T12:00:00Z',
    updated_at: '2026-05-19T12:00:00Z',
    line_items: [],
    ...(args.bodyOverrides ?? {}),
  };
  return {
    topic: args.topic,
    webhookId: args.webhookId,
    body,
  };
}

describe('handleOrderEvent — order.placed / order.updated (stub)', () => {
  it('returns without throwing on a producer-shaped order.placed payload', async () => {
    const ctx = makeCtx();
    await expect(
      handleOrderEvent(
        ctx,
        makeRow(
          'order.placed',
          producerPayload({ topic: 'orders/create', webhookId: 'wh-1', shopifyOrderId: 12345 }),
        ),
        'order.placed',
      ),
    ).resolves.toBeUndefined();
  });

  it('accepts string-typed Shopify order ids (Shopify sometimes sends strings)', async () => {
    const ctx = makeCtx();
    await expect(
      handleOrderEvent(
        ctx,
        makeRow(
          'order.updated',
          producerPayload({ topic: 'orders/updated', webhookId: 'wh-2', shopifyOrderId: 'gid://shopify/Order/12345' }),
        ),
        'order.updated',
      ),
    ).resolves.toBeUndefined();
  });

  it('throws ZodError when body.id is missing — body.id is required (locked in EPIC-E-FIELD-MAPPING.md row #1)', async () => {
    const ctx = makeCtx();
    // Hand-build a body without `id` (producerPayload requires shopifyOrderId).
    const payload = {
      topic: 'orders/create',
      webhookId: 'wh-no-id',
      body: {
        currency: 'USD',
        subtotal_price_set: {
          shop_money: { amount: '0.00', currency_code: 'USD' },
          presentment_money: { amount: '0.00', currency_code: 'USD' },
        },
        total_price_set: {
          shop_money: { amount: '0.00', currency_code: 'USD' },
          presentment_money: { amount: '0.00', currency_code: 'USD' },
        },
        total_tax_set: {
          shop_money: { amount: '0.00', currency_code: 'USD' },
          presentment_money: { amount: '0.00', currency_code: 'USD' },
        },
        total_discounts_set: {
          shop_money: { amount: '0.00', currency_code: 'USD' },
          presentment_money: { amount: '0.00', currency_code: 'USD' },
        },
        created_at: '2026-05-19T12:00:00Z',
        updated_at: '2026-05-19T12:00:00Z',
        line_items: [],
      },
    };
    await expect(
      handleOrderEvent(ctx, makeRow('order.placed', payload), 'order.placed'),
    ).rejects.toThrow();
  });

  it('throws ZodError when topic is missing — breaks loudly on producer-shape drift', async () => {
    const ctx = makeCtx();
    await expect(
      handleOrderEvent(
        ctx,
        makeRow('order.placed', { webhookId: 'wh-4', body: { id: 1 } }),
        'order.placed',
      ),
    ).rejects.toThrow();
  });

  it('throws ZodError when webhookId is missing — breaks loudly on producer-shape drift', async () => {
    const ctx = makeCtx();
    await expect(
      handleOrderEvent(
        ctx,
        makeRow('order.placed', { topic: 'orders/create', body: { id: 1 } }),
        'order.placed',
      ),
    ).rejects.toThrow();
  });

  it('throws ZodError when body is missing — breaks loudly on producer-shape drift', async () => {
    const ctx = makeCtx();
    await expect(
      handleOrderEvent(
        ctx,
        makeRow('order.placed', { topic: 'orders/create', webhookId: 'wh-5' }),
        'order.placed',
      ),
    ).rejects.toThrow();
  });
});

describe('handleOrderNoop', () => {
  it('returns without throwing for order.cancelled', async () => {
    await expect(
      handleOrderNoop(makeRow('order.cancelled', { whatever: true })),
    ).resolves.toBeUndefined();
  });

  it('returns without throwing for order.refunded', async () => {
    await expect(
      handleOrderNoop(makeRow('order.refunded', { whatever: true })),
    ).resolves.toBeUndefined();
  });
});
