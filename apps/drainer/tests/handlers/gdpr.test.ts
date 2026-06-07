/**
 * GDPR adapter tests — assert the adapter narrows the payload through
 * the matching zod schema and forwards the correct args to the
 * compliance processor. No real Prisma, no real audit writes.
 */

import type { OutboxEventRow } from '@winback/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the compliance processors from @winback/db.
vi.mock('@winback/db', async () => {
  const actual = await vi.importActual<typeof import('@winback/db')>('@winback/db');
  return {
    ...actual,
    processCustomerDataRequest: vi.fn().mockResolvedValue(undefined),
    processCustomerRedact: vi.fn().mockResolvedValue(undefined),
    processShopRedact: vi.fn().mockResolvedValue(undefined),
  };
});

const dbMod = await import('@winback/db');
const {
  handleCustomerDataRequested,
  handleCustomerRedacted,
  handleShopRedacted,
} = await import('../../src/handlers/gdpr.js');

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

const stubCtx = {
  prisma: { __stubPrisma: true } as unknown,
  queues: {},
  shopifyConfig: {},
} as unknown as Parameters<typeof handleCustomerDataRequested>[0];

afterEach(() => {
  vi.clearAllMocks();
});

describe('handleCustomerDataRequested', () => {
  it('forwards narrowed payload + merchantId + shop to processCustomerDataRequest', async () => {
    const payload = {
      shop_domain: 'test-shop.myshopify.com',
      shop_id: 12345,
      customer: { id: 999, email: 'x@y.com', phone: null },
      orders_requested: [1, 2, 3],
    };

    await handleCustomerDataRequested(stubCtx, makeRow('gdpr.customer_data_requested', payload));

    expect(dbMod.processCustomerDataRequest).toHaveBeenCalledTimes(1);
    expect(dbMod.processCustomerDataRequest).toHaveBeenCalledWith({
      prisma: stubCtx.prisma,
      merchantId: 'merchant-1',
      shop: 'test-shop.myshopify.com',
      payload: expect.objectContaining({
        shop_domain: 'test-shop.myshopify.com',
        customer: expect.objectContaining({ id: 999 }),
      }),
    });
  });

  it('throws on missing shop_domain', async () => {
    await expect(
      handleCustomerDataRequested(stubCtx, makeRow('gdpr.customer_data_requested', { customer: {} })),
    ).rejects.toThrow();
    expect(dbMod.processCustomerDataRequest).not.toHaveBeenCalled();
  });
});

describe('handleCustomerRedacted', () => {
  it('forwards narrowed payload + merchantId + shop to processCustomerRedact', async () => {
    const payload = {
      shop_domain: 'shop.myshopify.com',
      customer: { id: 42 },
      orders_to_redact: ['a', 'b'],
    };

    await handleCustomerRedacted(stubCtx, makeRow('gdpr.customer_redacted', payload));

    expect(dbMod.processCustomerRedact).toHaveBeenCalledWith({
      prisma: stubCtx.prisma,
      merchantId: 'merchant-1',
      shop: 'shop.myshopify.com',
      payload: expect.objectContaining({ shop_domain: 'shop.myshopify.com' }),
    });
  });

  it('throws on malformed customer.id type', async () => {
    await expect(
      handleCustomerRedacted(stubCtx, makeRow('gdpr.customer_redacted', {
        shop_domain: 'shop.myshopify.com',
        customer: { id: { weird: 'object' } },
      })),
    ).rejects.toThrow();
  });
});

describe('handleShopRedacted', () => {
  it('forwards narrowed payload + shop to processShopRedact (no merchantId arg)', async () => {
    const payload = { shop_domain: 'tenant.myshopify.com', shop_id: 7 };

    await handleShopRedacted(stubCtx, makeRow('gdpr.shop_redacted', payload));

    expect(dbMod.processShopRedact).toHaveBeenCalledWith({
      prisma: stubCtx.prisma,
      shop: 'tenant.myshopify.com',
      payload: expect.objectContaining({ shop_domain: 'tenant.myshopify.com', shop_id: 7 }),
    });
  });

  it('throws on missing shop_domain', async () => {
    await expect(
      handleShopRedacted(stubCtx, makeRow('gdpr.shop_redacted', {})),
    ).rejects.toThrow();
  });
});
