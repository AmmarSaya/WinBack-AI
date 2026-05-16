/**
 * order.* stub handler tests.
 *
 * For `order.placed` / `order.updated`: verifies the
 * attribution.compute job is enqueued with the v1 payload shape locked
 * in handlers/order.ts.
 *
 * For `order.cancelled` / `order.refunded`: noop (logged + returned).
 */

import type { OutboxEventRow } from '@winback/db';
import { describe, expect, it, vi } from 'vitest';

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
  };
}

function makeCtx(addMock: ReturnType<typeof vi.fn>): DrainerContext {
  return {
    prisma: {} as DrainerContext['prisma'],
    queues: {
      attributionCompute: { add: addMock } as unknown as DrainerContext['queues']['attributionCompute'],
      outboxDrain: {} as DrainerContext['queues']['outboxDrain'],
    },
    shopifyConfig: {} as DrainerContext['shopifyConfig'],
  };
}

describe('handleOrderEvent — order.placed', () => {
  it('enqueues an attribution.compute@v1 job with the locked payload shape', async () => {
    const addMock = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx(addMock);

    await handleOrderEvent(
      ctx,
      makeRow('order.placed', { orderId: 'order-abc' }),
      'order.placed',
    );

    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith('attribution.compute@v1', {
      merchantId: 'merchant-1',
      orderId: 'order-abc',
      eventType: 'order.placed',
      outboxEventId: 'row-order.placed',
    });
  });

  it('enqueues with eventType=order.updated when called with that discriminator', async () => {
    const addMock = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx(addMock);

    await handleOrderEvent(
      ctx,
      makeRow('order.updated', { orderId: 'order-xyz' }),
      'order.updated',
    );

    expect(addMock).toHaveBeenCalledWith(
      'attribution.compute@v1',
      expect.objectContaining({ eventType: 'order.updated', orderId: 'order-xyz' }),
    );
  });

  it('throws zod error on missing orderId', async () => {
    const addMock = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx(addMock);

    await expect(
      handleOrderEvent(ctx, makeRow('order.placed', {}), 'order.placed'),
    ).rejects.toThrow();
    expect(addMock).not.toHaveBeenCalled();
  });
});

describe('handleOrderNoop', () => {
  it('returns without throwing for order.cancelled', async () => {
    await expect(
      handleOrderNoop(makeRow('order.cancelled', { orderId: 'x' })),
    ).resolves.toBeUndefined();
  });

  it('returns without throwing for order.refunded', async () => {
    await expect(
      handleOrderNoop(makeRow('order.refunded', { orderId: 'x' })),
    ).resolves.toBeUndefined();
  });
});
