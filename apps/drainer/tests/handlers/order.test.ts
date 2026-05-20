/**
 * Unit tests for the post-Epic-E-session-1 order handlers.
 *
 * Strategy: mock `@winback/db` via `vi.mock` + `vi.hoisted` so we can
 * assert that `OrderRepository.upsertFromWebhook` was called with the
 * correct merchantId + body. `withTenantScope` is replaced with a
 * pass-through to keep tests synchronous. `prisma.$transaction` on the
 * stub context just invokes the callback with a stub tx. Real-DB
 * coverage lands in the batch 5 drainer integration harness.
 *
 * The pre-batch-4 stub tests ("parses successfully and returns") are
 * removed because the new handler does real work; we assert that work
 * via the repository spy. Negative-path tests (missing topic / webhookId
 * / body) stay — they exercise the envelope's zod parse which fires
 * BEFORE any repository call.
 */

import type { OutboxEventRow } from '@winback/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DrainerContext } from '../../src/context.js';

// vi.hoisted exposes the inner spy to both the mock factory + the tests.
const mocks = vi.hoisted(() => ({
  upsertFromWebhook: vi.fn().mockResolvedValue({
    orderId: 'order_local_1',
    isNewOrder: true,
    qualifyingTransition: 'paid_new' as const,
    previousFinancialStatus: null,
  }),
}));

vi.mock('@winback/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@winback/db')>();
  return {
    ...actual,
    OrderRepository: vi.fn().mockImplementation(() => ({
      upsertFromWebhook: mocks.upsertFromWebhook,
    })),
    // Pass-through tenant scope so tests don't need to manage ALS state.
    withTenantScope: <T,>(_id: string, fn: () => Promise<T>) => fn(),
  };
});

// Import AFTER the mock so the handler sees the mocked class + scope.
const { handleOrderEvent, handleOrderNoop } = await import('../../src/handlers/order.js');

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

/**
 * Stub context. `prisma.$transaction(cb)` just invokes the callback
 * with a sentinel tx — the repository is mocked so we don't care what
 * the tx is.
 */
function makeCtx(): DrainerContext {
  const stubTx = { __stub: true } as unknown;
  const stubPrisma = {
    $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(stubTx)),
  } as unknown as DrainerContext['prisma'];
  return {
    prisma: stubPrisma,
    queues: {} as DrainerContext['queues'],
    shopifyConfig: {} as DrainerContext['shopifyConfig'],
  };
}

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

beforeEach(() => {
  // Default success result; individual tests can override per-call.
  mocks.upsertFromWebhook.mockResolvedValue({
    orderId: 'order_local_1',
    isNewOrder: true,
    qualifyingTransition: 'paid_new',
    previousFinancialStatus: null,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('handleOrderEvent — calls OrderRepository.upsertFromWebhook', () => {
  it('orders/create → repo called with merchantId + body + tx; receives qualifying transition back', async () => {
    const ctx = makeCtx();
    await handleOrderEvent(
      ctx,
      makeRow(
        'order.placed',
        producerPayload({ topic: 'orders/create', webhookId: 'wh-1', shopifyOrderId: 12345 }),
      ),
      'order.placed',
    );

    expect(mocks.upsertFromWebhook).toHaveBeenCalledTimes(1);
    const call = mocks.upsertFromWebhook.mock.calls[0][0];
    expect(call.merchantId).toBe('merchant-1');
    expect(call.body.id).toBe(12345);
    // tx is whatever $transaction passed — sentinel from makeCtx.
    expect(call.tx).toBeDefined();
  });

  it('orders/updated discriminator → repo called the same way; eventType only affects log', async () => {
    const ctx = makeCtx();
    await handleOrderEvent(
      ctx,
      makeRow(
        'order.updated',
        producerPayload({ topic: 'orders/updated', webhookId: 'wh-2', shopifyOrderId: 99 }),
      ),
      'order.updated',
    );

    expect(mocks.upsertFromWebhook).toHaveBeenCalledTimes(1);
    expect(mocks.upsertFromWebhook.mock.calls[0][0].body.id).toBe(99);
  });

  it('paid_continued result propagates through (returned by repo, logged by handler)', async () => {
    mocks.upsertFromWebhook.mockResolvedValue({
      orderId: 'order_local_x',
      isNewOrder: false,
      qualifyingTransition: 'paid_continued',
      previousFinancialStatus: 'pending',
    });
    const ctx = makeCtx();
    await expect(
      handleOrderEvent(
        ctx,
        makeRow('order.updated', producerPayload({ topic: 'orders/updated', webhookId: 'wh-3', shopifyOrderId: 1 })),
        'order.updated',
      ),
    ).resolves.toBeUndefined();
    // Handler doesn't expose the result outside the log; we verify the
    // repo was called and the mock returned without throw.
    expect(mocks.upsertFromWebhook).toHaveBeenCalledTimes(1);
  });

  it('repository throw propagates (drainer per-row catch markFails/DLQs)', async () => {
    mocks.upsertFromWebhook.mockRejectedValueOnce(new Error('test: simulated repository failure'));
    const ctx = makeCtx();
    await expect(
      handleOrderEvent(
        ctx,
        makeRow('order.placed', producerPayload({ topic: 'orders/create', webhookId: 'wh-fail', shopifyOrderId: 1 })),
        'order.placed',
      ),
    ).rejects.toThrow(/simulated repository failure/);
  });
});

describe('handleOrderEvent — envelope validation (fires BEFORE repo call)', () => {
  it('throws ZodError when body.id is missing — locks the producer-shape contract', async () => {
    const ctx = makeCtx();
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
    expect(mocks.upsertFromWebhook).not.toHaveBeenCalled();
  });

  it('throws ZodError when topic is missing', async () => {
    const ctx = makeCtx();
    await expect(
      handleOrderEvent(
        ctx,
        makeRow('order.placed', { webhookId: 'wh-x', body: { id: 1 } }),
        'order.placed',
      ),
    ).rejects.toThrow();
    expect(mocks.upsertFromWebhook).not.toHaveBeenCalled();
  });

  it('throws ZodError when webhookId is missing', async () => {
    const ctx = makeCtx();
    await expect(
      handleOrderEvent(
        ctx,
        makeRow('order.placed', { topic: 'orders/create', body: { id: 1 } }),
        'order.placed',
      ),
    ).rejects.toThrow();
    expect(mocks.upsertFromWebhook).not.toHaveBeenCalled();
  });

  it('throws ZodError when body is missing', async () => {
    const ctx = makeCtx();
    await expect(
      handleOrderEvent(
        ctx,
        makeRow('order.placed', { topic: 'orders/create', webhookId: 'wh' }),
        'order.placed',
      ),
    ).rejects.toThrow();
    expect(mocks.upsertFromWebhook).not.toHaveBeenCalled();
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
