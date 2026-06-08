import type { Prisma } from '@prisma/client';
import { ValidationError } from '@winback/errors';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { WinbackPrisma } from '../src/client.js';
import { OrderRepository } from '../src/repositories/order.repository.js';
import type { ShopifyOrderWebhookBody } from '../src/webhook-bodies.js';

/**
 * Unit tests for OrderRepository.upsertFromWebhook against a mocked
 * Prisma transaction client. Real-DB coverage is the batch 5 drainer
 * integration harness.
 *
 * Mock shape: a TransactionClient stub with vi.fn() for each delegate
 * method used. Production code never reads `this.prisma` in the new
 * method — all DB I/O goes through `tx` — so the constructor-passed
 * client can be an empty object.
 */

const MERCHANT_ID = 'm_test';
const LOCAL_ORDER_ID = 'order_local_1';

interface MockTx {
  order: {
    findUnique: Mock;
    upsert: Mock;
  };
  customer: {
    findUnique: Mock;
  };
  product: { findMany: Mock };
  productVariant: { findMany: Mock };
  orderLineItem: { upsert: Mock };
}

function makeTx(): MockTx {
  return {
    order: {
      findUnique: vi.fn(),
      upsert: vi.fn().mockResolvedValue({ id: LOCAL_ORDER_ID }),
    },
    customer: { findUnique: vi.fn().mockResolvedValue(null) },
    product: { findMany: vi.fn().mockResolvedValue([]) },
    productVariant: { findMany: vi.fn().mockResolvedValue([]) },
    orderLineItem: { upsert: vi.fn() },
  };
}

const MONEY_ZERO = {
  shop_money: { amount: '0.00', currency_code: 'USD' },
  presentment_money: { amount: '0.00', currency_code: 'USD' },
};

/**
 * Producer-shaped body matching the post-Epic-E session 1 schema.
 * `bodyOverrides` lets tests target specific MAPPED fields.
 */
function makeBody(overrides: Partial<ShopifyOrderWebhookBody> = {}): ShopifyOrderWebhookBody {
  return {
    id: 12345,
    name: '#1001',
    test: false,
    financial_status: 'paid',
    fulfillment_status: null,
    customer: null,
    currency: 'USD',
    presentment_currency: null,
    subtotal_price: '100.00',
    subtotal_price_set: {
      shop_money: { amount: '100.00', currency_code: 'USD' },
      presentment_money: { amount: '100.00', currency_code: 'USD' },
    },
    total_price: '110.00',
    total_price_set: {
      shop_money: { amount: '110.00', currency_code: 'USD' },
      presentment_money: { amount: '110.00', currency_code: 'USD' },
    },
    total_tax: '10.00',
    total_tax_set: {
      shop_money: { amount: '10.00', currency_code: 'USD' },
      presentment_money: { amount: '10.00', currency_code: 'USD' },
    },
    total_discounts: '0.00',
    total_discounts_set: MONEY_ZERO,
    created_at: '2026-05-19T12:00:00Z',
    updated_at: '2026-05-19T12:00:00Z',
    processed_at: null,
    cancelled_at: null,
    line_items: [],
    ...overrides,
  };
}

describe('OrderRepository.upsertFromWebhook', () => {
  let repo: OrderRepository;
  let tx: MockTx;

  beforeEach(() => {
    repo = new OrderRepository({} as WinbackPrisma);
    tx = makeTx();
  });

  // -------- qualifying transition logic --------

  it('new order with paid status → paid_new + isNewOrder=true', async () => {
    tx.order.findUnique.mockResolvedValue(null);
    const result = await repo.upsertFromWebhook({
      merchantId: MERCHANT_ID,
      body: makeBody({ financial_status: 'paid' }),
      tx: tx as unknown as Prisma.TransactionClient,
    });
    expect(result.qualifyingTransition).toBe('paid_new');
    expect(result.isNewOrder).toBe(true);
    expect(result.previousFinancialStatus).toBeNull();
  });

  it('existing order, prior=pending, new=paid → paid_continued', async () => {
    tx.order.findUnique.mockResolvedValue({ id: LOCAL_ORDER_ID, financialStatus: 'pending' });
    const result = await repo.upsertFromWebhook({
      merchantId: MERCHANT_ID,
      body: makeBody({ financial_status: 'paid' }),
      tx: tx as unknown as Prisma.TransactionClient,
    });
    expect(result.qualifyingTransition).toBe('paid_continued');
    expect(result.isNewOrder).toBe(false);
    expect(result.previousFinancialStatus).toBe('pending');
  });

  it('existing order, prior=paid, new=paid → no_change (idempotent re-delivery)', async () => {
    tx.order.findUnique.mockResolvedValue({ id: LOCAL_ORDER_ID, financialStatus: 'paid' });
    const result = await repo.upsertFromWebhook({
      merchantId: MERCHANT_ID,
      body: makeBody({ financial_status: 'paid' }),
      tx: tx as unknown as Prisma.TransactionClient,
    });
    expect(result.qualifyingTransition).toBe('no_change');
  });

  it('order with non-paid status → non_paid regardless of prior', async () => {
    tx.order.findUnique.mockResolvedValue(null);
    const result = await repo.upsertFromWebhook({
      merchantId: MERCHANT_ID,
      body: makeBody({ financial_status: 'pending' }),
      tx: tx as unknown as Prisma.TransactionClient,
    });
    expect(result.qualifyingTransition).toBe('non_paid');
  });

  // -------- customer FK resolution (P-10) --------

  it('order with body.customer.id matching local customer → Order.customerId set', async () => {
    tx.order.findUnique.mockResolvedValue(null);
    tx.customer.findUnique.mockResolvedValue({ id: 'local_customer_1' });
    await repo.upsertFromWebhook({
      merchantId: MERCHANT_ID,
      body: makeBody({ customer: { id: 99 } }),
      tx: tx as unknown as Prisma.TransactionClient,
    });
    expect(tx.customer.findUnique).toHaveBeenCalledWith({
      where: {
        merchantId_shopifyCustomerId: {
          merchantId: MERCHANT_ID,
          shopifyCustomerId: 'gid://shopify/Customer/99',
        },
      },
      select: { id: true },
    });
    const upsertCall = tx.order.upsert.mock.calls[0]![0];
    expect(upsertCall.create.customerId).toBe('local_customer_1');
  });

  it('order with body.customer absent (guest checkout) → customerId null', async () => {
    tx.order.findUnique.mockResolvedValue(null);
    await repo.upsertFromWebhook({
      merchantId: MERCHANT_ID,
      body: makeBody({ customer: null }),
      tx: tx as unknown as Prisma.TransactionClient,
    });
    expect(tx.customer.findUnique).not.toHaveBeenCalled();
    const upsertCall = tx.order.upsert.mock.calls[0]![0];
    expect(upsertCall.create.customerId).toBeNull();
  });

  it('order with body.customer.id but customer not in local DB → customerId null', async () => {
    tx.order.findUnique.mockResolvedValue(null);
    tx.customer.findUnique.mockResolvedValue(null); // not found locally
    await repo.upsertFromWebhook({
      merchantId: MERCHANT_ID,
      body: makeBody({ customer: { id: 999 } }),
      tx: tx as unknown as Prisma.TransactionClient,
    });
    const upsertCall = tx.order.upsert.mock.calls[0]![0];
    expect(upsertCall.create.customerId).toBeNull();
  });

  // -------- _set optional handling (zero-default per audit contract) --------

  it('missing total_tax_set → totalTaxCents defaulted to 0n', async () => {
    tx.order.findUnique.mockResolvedValue(null);
    const body = makeBody();
    // delete is needed to remove the field entirely (not just null it)
    delete (body as Partial<ShopifyOrderWebhookBody>).total_tax_set;
    await repo.upsertFromWebhook({
      merchantId: MERCHANT_ID,
      body,
      tx: tx as unknown as Prisma.TransactionClient,
    });
    const upsertCall = tx.order.upsert.mock.calls[0]![0];
    expect(upsertCall.create.totalTaxCents).toBe(0n);
  });

  it('missing total_discounts_set → totalDiscountCents defaulted to 0n', async () => {
    tx.order.findUnique.mockResolvedValue(null);
    const body = makeBody();
    delete (body as Partial<ShopifyOrderWebhookBody>).total_discounts_set;
    await repo.upsertFromWebhook({
      merchantId: MERCHANT_ID,
      body,
      tx: tx as unknown as Prisma.TransactionClient,
    });
    const upsertCall = tx.order.upsert.mock.calls[0]![0];
    expect(upsertCall.create.totalDiscountCents).toBe(0n);
  });

  // -------- line item handling --------

  it('line items with known product + variant FKs → both linked in upsert', async () => {
    tx.order.findUnique.mockResolvedValue(null);
    tx.product.findMany.mockResolvedValue([
      { id: 'prod_local_1', shopifyProductId: 'gid://shopify/Product/501' },
    ]);
    tx.productVariant.findMany.mockResolvedValue([
      { id: 'var_local_1', shopifyVariantId: 'gid://shopify/ProductVariant/601' },
    ]);
    await repo.upsertFromWebhook({
      merchantId: MERCHANT_ID,
      body: makeBody({
        line_items: [
          {
            id: 701,
            product_id: 501,
            variant_id: 601,
            title: 'Widget',
            quantity: 2,
            price: '10.00',
            price_set: {
              shop_money: { amount: '10.00', currency_code: 'USD' },
              presentment_money: { amount: '10.00', currency_code: 'USD' },
            },
          },
        ],
      }),
      tx: tx as unknown as Prisma.TransactionClient,
    });
    expect(tx.orderLineItem.upsert).toHaveBeenCalledTimes(1);
    const liCall = tx.orderLineItem.upsert.mock.calls[0]![0];
    expect(liCall.create.productId).toBe('prod_local_1');
    expect(liCall.create.productVariantId).toBe('var_local_1');
    expect(liCall.create.quantity).toBe(2);
    expect(liCall.create.unitPriceCents).toBe(1000n);
    expect(liCall.create.currency).toBe('USD'); // sourced from parent Order
  });

  it('line items with unknown product/variant FKs → null FKs, no throw', async () => {
    tx.order.findUnique.mockResolvedValue(null);
    // product.findMany returns empty — product not found locally
    await repo.upsertFromWebhook({
      merchantId: MERCHANT_ID,
      body: makeBody({
        line_items: [
          {
            id: 702,
            product_id: 502, // not in DB
            variant_id: 602, // not in DB
            title: 'Mystery item',
            quantity: 1,
            price: '5.00',
            price_set: {
              shop_money: { amount: '5.00', currency_code: 'USD' },
              presentment_money: { amount: '5.00', currency_code: 'USD' },
            },
          },
        ],
      }),
      tx: tx as unknown as Prisma.TransactionClient,
    });
    const liCall = tx.orderLineItem.upsert.mock.calls[0]![0];
    expect(liCall.create.productId).toBeNull();
    expect(liCall.create.productVariantId).toBeNull();
  });

  it('orderLineItem.upsert keyed on (merchantId, orderId, shopifyLineItemId) — S-4 tenant-safety lock', async () => {
    tx.order.findUnique.mockResolvedValue(null);
    await repo.upsertFromWebhook({
      merchantId: MERCHANT_ID,
      body: makeBody({
        customer: { id: 12345 },
        line_items: [
          {
            id: 999,
            product_id: 501,
            variant_id: 601,
            title: 'Regression-lock widget',
            quantity: 1,
            price: '10.00',
            price_set: {
              shop_money: { amount: '10.00', currency_code: 'USD' },
              presentment_money: { amount: '10.00', currency_code: 'USD' },
            },
          },
        ],
      }),
      tx: tx as unknown as Prisma.TransactionClient,
    });

    // S-4: the where MUST carry merchantId so the Prisma extension's
    // findUnique-skip path can't be exploited by a future caller writing
    // outside the active tenant scope.  Locked here so a refactor that
    // drops merchantId from the composite-key accessor fails loud.
    const liCall = tx.orderLineItem.upsert.mock.calls[0]![0];
    expect(liCall.where).toEqual({
      merchantId_orderId_shopifyLineItemId: {
        merchantId: MERCHANT_ID,
        orderId: expect.any(String),
        shopifyLineItemId: 'gid://shopify/LineItem/999',
      },
    });
  });

  // -------- enum + money validation --------

  it('invalid financial_status enum → throws ValidationError (gates CP-2 attribution)', async () => {
    tx.order.findUnique.mockResolvedValue(null);
    await expect(
      repo.upsertFromWebhook({
        merchantId: MERCHANT_ID,
        body: makeBody({ financial_status: 'not_a_real_status' }),
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('unknown fulfillment_status → stored as null, no throw (asymmetric with financial_status — fulfillment is informational, not gate-critical)', async () => {
    tx.order.findUnique.mockResolvedValue(null);
    await repo.upsertFromWebhook({
      merchantId: MERCHANT_ID,
      body: makeBody({ fulfillment_status: 'partially_fulfilled' /* Shopify-could-add-later */ }),
      tx: tx as unknown as Prisma.TransactionClient,
    });
    const upsertCall = tx.order.upsert.mock.calls[0]![0];
    expect(upsertCall.create.fulfillmentStatus).toBeNull();
  });

  it('malformed money string → throws ValidationError (from parseMoneyToCents)', async () => {
    tx.order.findUnique.mockResolvedValue(null);
    await expect(
      repo.upsertFromWebhook({
        merchantId: MERCHANT_ID,
        body: makeBody({
          subtotal_price_set: {
            shop_money: { amount: 'not-a-number', currency_code: 'USD' },
            presentment_money: { amount: '100.00', currency_code: 'USD' },
          },
        }),
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    ).rejects.toThrow(ValidationError);
  });

  // -------- TX invariant lock (regression for the ⚠ in docstring) --------

  it('uses args.tx (not this.prisma) for the prior-status findUnique read', async () => {
    tx.order.findUnique.mockResolvedValue(null);
    await repo.upsertFromWebhook({
      merchantId: MERCHANT_ID,
      body: makeBody(),
      tx: tx as unknown as Prisma.TransactionClient,
    });
    // The mock was called on tx.order.findUnique. If the repo accidentally
    // used `this.prisma` instead, the mock here would not have been
    // invoked (the prisma constructor arg is `{}` with no method).
    expect(tx.order.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('OrderRepository — Shopify GID validation', () => {
  it('throws ValidationError if body.id is not numeric (would-be GID null)', async () => {
    const repo = new OrderRepository({} as WinbackPrisma);
    const tx = makeTx();
    await expect(
      repo.upsertFromWebhook({
        merchantId: MERCHANT_ID,
        body: makeBody({ id: 'not-numeric' }),
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    ).rejects.toThrow(ValidationError);
  });
});
