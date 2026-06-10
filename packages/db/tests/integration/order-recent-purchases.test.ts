/**
 * Integration tests for `OrderRepository.findRecentPurchasedTitles` (A4 /
 * POST-EPIC-F §3) against real Postgres (`pnpm db:test`).
 *
 * Why this file exists: the method's correctness lives entirely in raw SQL —
 * the `COALESCE("shopifyProcessedAt", "placedAt")` recency ordering, the
 * `DISTINCT ON` primary-line-item tie-break, the `isTest`/`financialStatus`
 * filters, and the `LIMIT`. The unit test (`order-repository.test.ts`) mocks
 * `$queryRaw` and so can only verify the wrapper (scope assertion, result
 * mapping); it CANNOT verify the SQL itself. These tests pin the SQL behavior
 * by execution against seeded data — the same posture as
 * `outbox-claim-batch.test.ts` pinning `FOR UPDATE SKIP LOCKED`.
 *
 * One assertion per §3 decision:
 *   - recency-DESC ordering + LIMIT 3        (Decision A)
 *   - COALESCE fallback (null processedAt)   (Decision A)
 *   - isTest = true excluded                 (Decision C)
 *   - non-paid excluded; partially_paid in   (financialStatus filter)
 *   - primary line item = lowest shopifyLineItemId (Decision B)
 *   - empty result → []                      (graceful-omit path)
 *   - other customer's orders excluded       (customer scoping)
 *
 * Harness: real Postgres; `singleFork: true` (vitest.integration.config.ts) —
 * tests serialize, no cross-test races.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { OrderRepository, withSystemScope, withTenantScope } from '../../src/index.js';

import { createTestMerchant, getTestClient, resetDb } from './setup.js';

const SHOP = 'recent-purchases.myshopify.com';

const prisma = getTestClient();
const repo = new OrderRepository(prisma);

let merchantId: string;
let customerId: string;
let otherCustomerId: string;

beforeAll(async () => {
  await resetDb();
  merchantId = await createTestMerchant(SHOP);
  customerId = await seedCustomer('gid://shopify/Customer/1');
  otherCustomerId = await seedCustomer('gid://shopify/Customer/2');
});

beforeEach(async () => {
  // Clear orders + line items between tests; keep the merchant + customers
  // (shared across the suite). Line items first (FK to Order).
  await withSystemScope('test.cleanup_orders', async () => {
    await prisma.orderLineItem.deleteMany({ where: { merchantId } });
    await prisma.order.deleteMany({ where: { merchantId } });
  });
});

// ---------------------------------------------------------------------------
// Seed helpers — explicit merchantId throughout (system scope does NOT inject).
// ---------------------------------------------------------------------------

async function seedCustomer(shopifyCustomerId: string): Promise<string> {
  return withSystemScope('test.seed_customer', async () => {
    const c = await prisma.customer.create({
      data: {
        merchantId,
        shopifyCustomerId,
        email: `${shopifyCustomerId.split('/').pop() ?? 'x'}@example.com`,
      },
      select: { id: true },
    });
    return c.id;
  });
}

async function seedOrder(args: {
  shopifyOrderId: string;
  placedAt: Date;
  shopifyProcessedAt?: Date | null;
  financialStatus?: 'paid' | 'partially_paid' | 'pending' | 'refunded';
  isTest?: boolean;
  forCustomerId?: string;
  lineItems: ReadonlyArray<{ shopifyLineItemId: string; title: string }>;
}): Promise<void> {
  await withSystemScope('test.seed_order', async () => {
    await prisma.order.create({
      data: {
        merchantId,
        customerId: args.forCustomerId ?? customerId,
        shopifyOrderId: args.shopifyOrderId,
        currency: 'USD',
        subtotalAmountCents: 1000n,
        totalAmountCents: 1000n,
        financialStatus: args.financialStatus ?? 'paid',
        isTest: args.isTest ?? false,
        placedAt: args.placedAt,
        shopifyProcessedAt: args.shopifyProcessedAt ?? null,
        lineItems: {
          create: args.lineItems.map((li) => ({
            merchantId,
            shopifyLineItemId: li.shopifyLineItemId,
            title: li.title,
            quantity: 1,
            unitPriceCents: 1000n,
            currency: 'USD',
          })),
        },
      },
    });
  });
}

function recentTitles(forCustomerId: string = customerId): Promise<readonly string[]> {
  return withTenantScope(merchantId, async () =>
    repo.findRecentPurchasedTitles({ merchantId, customerId: forCustomerId }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OrderRepository.findRecentPurchasedTitles (integration, real Postgres)', () => {
  it('orders by COALESCE(processedAt, placedAt) DESC and returns only the most-recent 3 (Decision A)', async () => {
    // Four qualifying orders, distinct processedAt — newest first is A.
    await seedOrder({
      shopifyOrderId: 'gid://shopify/Order/104',
      placedAt: new Date('2026-01-04T00:00:00Z'),
      shopifyProcessedAt: new Date('2026-01-04T00:00:00Z'),
      lineItems: [{ shopifyLineItemId: 'gid://shopify/LineItem/1', title: 'A-newest' }],
    });
    await seedOrder({
      shopifyOrderId: 'gid://shopify/Order/103',
      placedAt: new Date('2026-01-03T00:00:00Z'),
      shopifyProcessedAt: new Date('2026-01-03T00:00:00Z'),
      lineItems: [{ shopifyLineItemId: 'gid://shopify/LineItem/2', title: 'B' }],
    });
    await seedOrder({
      shopifyOrderId: 'gid://shopify/Order/102',
      placedAt: new Date('2026-01-02T00:00:00Z'),
      shopifyProcessedAt: new Date('2026-01-02T00:00:00Z'),
      lineItems: [{ shopifyLineItemId: 'gid://shopify/LineItem/3', title: 'C' }],
    });
    await seedOrder({
      shopifyOrderId: 'gid://shopify/Order/101',
      placedAt: new Date('2026-01-01T00:00:00Z'),
      shopifyProcessedAt: new Date('2026-01-01T00:00:00Z'),
      lineItems: [{ shopifyLineItemId: 'gid://shopify/LineItem/4', title: 'D-oldest' }],
    });

    // Recency-DESC, capped at 3 — the oldest (D) is dropped.
    expect(await recentTitles()).toEqual(['A-newest', 'B', 'C']);
  });

  it('falls back to placedAt when shopifyProcessedAt is null (COALESCE — Decision A)', async () => {
    // X: no processedAt, placedAt Feb 1 → recency = Feb 1.
    await seedOrder({
      shopifyOrderId: 'gid://shopify/Order/200',
      placedAt: new Date('2026-02-01T00:00:00Z'),
      shopifyProcessedAt: null,
      lineItems: [{ shopifyLineItemId: 'gid://shopify/LineItem/10', title: 'null-processed-feb' }],
    });
    // Y: processedAt Jan 15 → recency = Jan 15 (older than X's Feb 1 fallback).
    await seedOrder({
      shopifyOrderId: 'gid://shopify/Order/201',
      placedAt: new Date('2026-01-15T00:00:00Z'),
      shopifyProcessedAt: new Date('2026-01-15T00:00:00Z'),
      lineItems: [{ shopifyLineItemId: 'gid://shopify/LineItem/11', title: 'has-processed-jan' }],
    });

    expect(await recentTitles()).toEqual(['null-processed-feb', 'has-processed-jan']);
  });

  it('excludes isTest = true orders (Decision C — divergence from the old Shopify call)', async () => {
    await seedOrder({
      shopifyOrderId: 'gid://shopify/Order/300',
      placedAt: new Date('2026-03-02T00:00:00Z'),
      isTest: true, // newer, but a TEST purchase → must NOT seed the winback
      lineItems: [{ shopifyLineItemId: 'gid://shopify/LineItem/20', title: 'test-purchase' }],
    });
    await seedOrder({
      shopifyOrderId: 'gid://shopify/Order/301',
      placedAt: new Date('2026-03-01T00:00:00Z'),
      isTest: false,
      lineItems: [{ shopifyLineItemId: 'gid://shopify/LineItem/21', title: 'real-purchase' }],
    });

    expect(await recentTitles()).toEqual(['real-purchase']);
  });

  it('includes paid + partially_paid, excludes other financial statuses', async () => {
    await seedOrder({
      shopifyOrderId: 'gid://shopify/Order/400',
      placedAt: new Date('2026-04-03T00:00:00Z'),
      financialStatus: 'pending', // newest, but not (partially_)paid → excluded
      lineItems: [{ shopifyLineItemId: 'gid://shopify/LineItem/30', title: 'pending' }],
    });
    await seedOrder({
      shopifyOrderId: 'gid://shopify/Order/401',
      placedAt: new Date('2026-04-02T00:00:00Z'),
      financialStatus: 'refunded', // excluded
      lineItems: [{ shopifyLineItemId: 'gid://shopify/LineItem/31', title: 'refunded' }],
    });
    await seedOrder({
      shopifyOrderId: 'gid://shopify/Order/402',
      placedAt: new Date('2026-04-01T12:00:00Z'),
      financialStatus: 'partially_paid', // included
      lineItems: [{ shopifyLineItemId: 'gid://shopify/LineItem/32', title: 'partially-paid' }],
    });
    await seedOrder({
      shopifyOrderId: 'gid://shopify/Order/403',
      placedAt: new Date('2026-04-01T00:00:00Z'),
      financialStatus: 'paid', // included
      lineItems: [{ shopifyLineItemId: 'gid://shopify/LineItem/33', title: 'paid' }],
    });

    // Only the two qualifying orders, recency-DESC.
    expect(await recentTitles()).toEqual(['partially-paid', 'paid']);
  });

  it('returns the deterministic primary line item per order — lowest shopifyLineItemId (Decision B)', async () => {
    // One order, three line items seeded out of id-order. Lowest id (…/10) wins.
    await seedOrder({
      shopifyOrderId: 'gid://shopify/Order/500',
      placedAt: new Date('2026-05-01T00:00:00Z'),
      lineItems: [
        { shopifyLineItemId: 'gid://shopify/LineItem/30', title: 'third-by-id' },
        { shopifyLineItemId: 'gid://shopify/LineItem/10', title: 'first-by-id' },
        { shopifyLineItemId: 'gid://shopify/LineItem/20', title: 'second-by-id' },
      ],
    });

    expect(await recentTitles()).toEqual(['first-by-id']);
  });

  it('returns [] when the customer has no qualifying orders (graceful-omit path)', async () => {
    // No orders seeded this test (beforeEach cleared them).
    expect(await recentTitles()).toEqual([]);
  });

  it('excludes another customer\'s orders (customer scoping)', async () => {
    await seedOrder({
      shopifyOrderId: 'gid://shopify/Order/600',
      placedAt: new Date('2026-06-01T00:00:00Z'),
      forCustomerId: otherCustomerId, // belongs to a DIFFERENT customer
      lineItems: [{ shopifyLineItemId: 'gid://shopify/LineItem/40', title: 'other-customer' }],
    });
    await seedOrder({
      shopifyOrderId: 'gid://shopify/Order/601',
      placedAt: new Date('2026-05-31T00:00:00Z'),
      forCustomerId: customerId,
      lineItems: [{ shopifyLineItemId: 'gid://shopify/LineItem/41', title: 'our-customer' }],
    });

    expect(await recentTitles(customerId)).toEqual(['our-customer']);
    expect(await recentTitles(otherCustomerId)).toEqual(['other-customer']);
  });
});
