/**
 * Unit tests for the post-Epic-E-session-2 order handler.
 *
 * Strategy: mock `@winback/db` via `vi.mock` + `vi.hoisted` so we can
 * assert that `OrderRepository.upsertFromWebhook` was called with the
 * correct merchantId + body AND that the scoring service was invoked
 * (or skipped) appropriately.  `withTenantScope` is replaced with a
 * pass-through to keep tests synchronous.  `prisma.$transaction` on the
 * stub context just invokes the callback with a stub tx.  Real-DB
 * coverage lands in the batch 5 drainer integration harness.
 *
 * The post-session-2 wiring runs scoring inline in the SAME tx as the
 * order upsert.  Two new contracts under test here:
 *   - customerId from the upsert is forwarded to recompute
 *   - customerId === null (guest checkout) → recompute SKIPPED
 *
 * Negative-path tests (missing topic / webhookId / body) exercise the
 * envelope's zod parse which fires BEFORE any repository call.
 */

import type { OutboxEventRow } from '@winback/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DrainerContext } from '../../src/context.js';

// vi.hoisted exposes the inner spies to both the mock factory + the tests.
const mocks = vi.hoisted(() => ({
  upsertFromWebhook: vi.fn(),
  recompute: vi.fn(),
}));

vi.mock('@winback/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@winback/db')>();
  return {
    ...actual,
    OrderRepository: vi.fn().mockImplementation(() => ({
      upsertFromWebhook: mocks.upsertFromWebhook,
    })),
    // CustomerScoreRepository + AuditLogRepository are instantiated by the
    // handler but never called directly (the service does that).  Just
    // return empty stubs.
    CustomerScoreRepository: vi.fn().mockImplementation(() => ({})),
    AuditLogRepository: vi.fn().mockImplementation(() => ({})),
    CustomerScoreService: vi.fn().mockImplementation(() => ({
      recompute: mocks.recompute,
    })),
    // Pass-through tenant scope so tests don't need to manage ALS state.
    withTenantScope: <T,>(_id: string, fn: () => Promise<T>) => fn(),
  };
});

// Import AFTER the mock so the handler sees the mocked classes + scope.
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
 * Stub context.  `prisma.$transaction(cb)` just invokes the callback
 * with a sentinel tx — the repository + service are mocked so we don't
 * care what the tx is.
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

/** Default upsert result — order with a resolved customer FK. */
function defaultUpsertResult() {
  return {
    orderId: 'order_local_1',
    customerId: 'cust_local_1',
    isNewOrder: true,
    qualifyingTransition: 'paid_new' as const,
    previousFinancialStatus: null,
  };
}

/** Default scoring result — applied, scorable branch, no state change. */
function defaultScoringResult() {
  return {
    skipped: null,
    customerScoreId: 'score_1',
    isNewScore: true,
    rDays: 5,
    fCount: 1,
    mCents: 19_995n,
    rQuintile: 5,
    fQuintile: 5,
    mQuintile: 5,
    churnRiskScore: 0,
    previousState: 'active' as const,
    newState: 'active' as const,
    stateChanged: false,
    branchTaken: 'scorable' as const,
    cohortSize: 8,
    durationMs: 12,
  };
}

beforeEach(() => {
  mocks.upsertFromWebhook.mockResolvedValue(defaultUpsertResult());
  mocks.recompute.mockResolvedValue(defaultScoringResult());
});

afterEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// Repository wiring + scoring integration
// ===========================================================================

describe('handleOrderEvent — calls OrderRepository.upsertFromWebhook', () => {
  it('orders/create → repo called with merchantId + body + tx', async () => {
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
    const call = mocks.upsertFromWebhook.mock.calls[0]![0];
    expect(call.merchantId).toBe('merchant-1');
    expect(call.body.id).toBe(12345);
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
    expect(mocks.upsertFromWebhook.mock.calls[0]![0].body.id).toBe(99);
  });

  it('paid_continued result propagates through (returned by repo, logged by handler)', async () => {
    mocks.upsertFromWebhook.mockResolvedValue({
      orderId: 'order_local_x',
      customerId: 'cust_local_x',
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

// ===========================================================================
// Epic E session 2 — scoring integration
// ===========================================================================

describe('handleOrderEvent — scoring service integration (Epic E session 2)', () => {
  it('customerId non-null → recompute called inline with that customerId + same tx', async () => {
    const ctx = makeCtx();
    await handleOrderEvent(
      ctx,
      makeRow(
        'order.placed',
        producerPayload({ topic: 'orders/create', webhookId: 'wh-s1', shopifyOrderId: 1 }),
      ),
      'order.placed',
    );

    expect(mocks.recompute).toHaveBeenCalledTimes(1);
    const call = mocks.recompute.mock.calls[0]![0];
    expect(call.merchantId).toBe('merchant-1');
    expect(call.customerId).toBe('cust_local_1');
    // Same tx sentinel that the order repo received.
    expect(call.tx).toBe(mocks.upsertFromWebhook.mock.calls[0]![0].tx);
  });

  it('customerId null (guest checkout) → recompute SKIPPED entirely (per P-10)', async () => {
    mocks.upsertFromWebhook.mockResolvedValue({
      orderId: 'order_guest',
      customerId: null, // guest checkout
      isNewOrder: true,
      qualifyingTransition: 'paid_new',
      previousFinancialStatus: null,
    });
    const ctx = makeCtx();
    await handleOrderEvent(
      ctx,
      makeRow(
        'order.placed',
        producerPayload({ topic: 'orders/create', webhookId: 'wh-guest', shopifyOrderId: 2 }),
      ),
      'order.placed',
    );

    expect(mocks.upsertFromWebhook).toHaveBeenCalledTimes(1);
    expect(mocks.recompute).not.toHaveBeenCalled();
  });

  it('scoring service throw propagates (parent tx rolls back via the repository client)', async () => {
    mocks.recompute.mockRejectedValueOnce(new Error('test: scoring failure'));
    const ctx = makeCtx();
    await expect(
      handleOrderEvent(
        ctx,
        makeRow(
          'order.placed',
          producerPayload({ topic: 'orders/create', webhookId: 'wh-sfail', shopifyOrderId: 3 }),
        ),
        'order.placed',
      ),
    ).rejects.toThrow(/scoring failure/);
  });

  it('scoring `skipped: customer_not_found` result is benign — handler returns normally', async () => {
    mocks.recompute.mockResolvedValue({
      skipped: 'customer_not_found',
      cohortSize: 0,
      durationMs: 1,
    });
    const ctx = makeCtx();
    await expect(
      handleOrderEvent(
        ctx,
        makeRow(
          'order.placed',
          producerPayload({ topic: 'orders/create', webhookId: 'wh-skip', shopifyOrderId: 4 }),
        ),
        'order.placed',
      ),
    ).resolves.toBeUndefined();
    // The order repo still ran; scoring was attempted but skipped.
    expect(mocks.upsertFromWebhook).toHaveBeenCalledTimes(1);
    expect(mocks.recompute).toHaveBeenCalledTimes(1);
  });

  it('scoring state change (active→warm) flows through without disturbing the order upsert', async () => {
    mocks.recompute.mockResolvedValue({
      ...defaultScoringResult(),
      previousState: 'active',
      newState: 'warm',
      stateChanged: true,
      branchTaken: 'scorable',
    });
    const ctx = makeCtx();
    await expect(
      handleOrderEvent(
        ctx,
        makeRow(
          'order.placed',
          producerPayload({ topic: 'orders/create', webhookId: 'wh-trans', shopifyOrderId: 5 }),
        ),
        'order.placed',
      ),
    ).resolves.toBeUndefined();
    expect(mocks.upsertFromWebhook).toHaveBeenCalledTimes(1);
    expect(mocks.recompute).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// Envelope validation
// ===========================================================================

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
    expect(mocks.recompute).not.toHaveBeenCalled();
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
    expect(mocks.recompute).not.toHaveBeenCalled();
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
    expect(mocks.recompute).not.toHaveBeenCalled();
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
    expect(mocks.recompute).not.toHaveBeenCalled();
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
