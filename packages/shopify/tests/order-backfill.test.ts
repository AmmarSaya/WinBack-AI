/**
 * Unit tests for the order-backfill adapter + processor wiring.
 *
 * The adapter `mapOrderNodeToWebhookBody` is the #1 correctness surface —
 * the GraphQL→webhook-body mapping that lets backfilled orders take the
 * IDENTICAL upsert path as webhook orders. The financial-status enum
 * EXHAUSTIVENESS test is the guard against the silent-corruption / throw
 * failure mode (an unmapped GraphQL value reaching parseFinancialStatus).
 *
 * The end-to-end "backfill then score → correct cohort" proof + the
 * silent-no-recompute property are in the drainer integration suite
 * (real DB).
 */

import { shopifyOrderWebhookBodySchema } from '@winback/db';
import { describe, expect, it, vi } from 'vitest';

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock('@winback/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  }),
}));

import {
  KNOWN_GRAPHQL_FINANCIAL_STATUSES,
  mapOrderNodeToWebhookBody,
  type ShopifyOrderNode,
} from '../src/backfill/order-backfill.js';

const MERCHANT_ID = 'm_test';

function moneyBag(shopAmount: string, presentmentAmount = shopAmount) {
  return {
    shopMoney: { amount: shopAmount, currencyCode: 'USD' },
    presentmentMoney: { amount: presentmentAmount, currencyCode: 'USD' },
  };
}

function makeOrderNode(overrides: Partial<ShopifyOrderNode> = {}): ShopifyOrderNode {
  return {
    id: 'gid://shopify/Order/5001',
    name: '#1001',
    test: false,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'FULFILLED',
    currencyCode: 'USD',
    presentmentCurrencyCode: 'USD',
    createdAt: '2026-01-15T10:00:00Z',
    updatedAt: '2026-01-15T10:05:00Z',
    processedAt: '2026-01-15T10:01:00Z',
    cancelledAt: null,
    subtotalPriceSet: moneyBag('90.00'),
    totalPriceSet: moneyBag('99.95'),
    totalTaxSet: moneyBag('9.95'),
    totalDiscountsSet: moneyBag('0.00'),
    customer: { id: 'gid://shopify/Customer/700' },
    lineItems: {
      nodes: [
        {
          id: 'gid://shopify/LineItem/8001',
          title: 'Widget',
          quantity: 2,
          originalUnitPriceSet: moneyBag('45.00'),
          product: { id: 'gid://shopify/Product/300' },
          variant: { id: 'gid://shopify/ProductVariant/400' },
        },
      ],
    },
    ...overrides,
  };
}

describe('mapOrderNodeToWebhookBody — full field mapping', () => {
  it('maps every field; GID→numeric for order/customer/product/variant/line-item; money paths preserved', () => {
    const body = mapOrderNodeToWebhookBody(makeOrderNode(), MERCHANT_ID);
    expect(body).not.toBeNull();
    const b = body!;

    expect(b.id).toBe('5001'); // numeric extracted from order GID
    expect(b.name).toBe('#1001');
    expect(b.test).toBe(false);
    expect(b.financial_status).toBe('paid'); // PAID → lowercase
    expect(b.fulfillment_status).toBe('fulfilled'); // FULFILLED → lowercase
    expect(b.currency).toBe('USD');
    expect(b.presentment_currency).toBe('USD');
    expect(b.created_at).toBe('2026-01-15T10:00:00Z');
    expect(b.updated_at).toBe('2026-01-15T10:05:00Z');
    expect(b.processed_at).toBe('2026-01-15T10:01:00Z');
    expect(b.cancelled_at).toBeNull();

    // Money: shopMoney.amount → the cohort-critical shop_money path.
    expect(b.total_price_set.shop_money.amount).toBe('99.95');
    expect(b.subtotal_price_set.shop_money.amount).toBe('90.00');
    expect(b.total_tax_set?.shop_money.amount).toBe('9.95');
    expect(b.total_discounts_set?.shop_money.amount).toBe('0.00');

    // Customer FK — numeric extracted from GID.
    expect(b.customer).toEqual({ id: '700' });

    // Line item — GID→numeric for id/product/variant; price + price_set.
    expect(b.line_items).toHaveLength(1);
    const li = b.line_items[0]!;
    expect(li.id).toBe('8001');
    expect(li.product_id).toBe('300');
    expect(li.variant_id).toBe('400');
    expect(li.title).toBe('Widget');
    expect(li.quantity).toBe(2);
    expect(li.price).toBe('45.00');
    expect(li.price_set.shop_money.amount).toBe('45.00');
  });

  it('output validates through shopifyOrderWebhookBodySchema (the boundary safety net)', () => {
    const body = mapOrderNodeToWebhookBody(makeOrderNode(), MERCHANT_ID);
    expect(() => shopifyOrderWebhookBodySchema.parse(body)).not.toThrow();
  });

  it('guest order (null customer) → body.customer is null', () => {
    const body = mapOrderNodeToWebhookBody(makeOrderNode({ customer: null }), MERCHANT_ID);
    expect(body!.customer).toBeNull();
  });

  it('line item with null product/variant → null FKs (not a throw)', () => {
    const body = mapOrderNodeToWebhookBody(
      makeOrderNode({
        lineItems: {
          nodes: [
            {
              id: 'gid://shopify/LineItem/8002',
              title: 'Mystery',
              quantity: 1,
              originalUnitPriceSet: moneyBag('10.00'),
              product: null,
              variant: null,
            },
          ],
        },
      }),
      MERCHANT_ID,
    );
    const li = body!.line_items[0]!;
    expect(li.product_id).toBeNull();
    expect(li.variant_id).toBeNull();
  });

  it('malformed order GID → returns null (skip + warn)', () => {
    warnSpy.mockClear();
    const body = mapOrderNodeToWebhookBody(
      makeOrderNode({ id: 'gid://shopify/Order/not-numeric' }),
      MERCHANT_ID,
    );
    expect(body).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('absent totalTaxSet/totalDiscountsSet (null) → undefined (optional in schema)', () => {
    const body = mapOrderNodeToWebhookBody(
      makeOrderNode({ totalTaxSet: null, totalDiscountsSet: null }),
      MERCHANT_ID,
    );
    expect(body!.total_tax_set).toBeUndefined();
    expect(body!.total_discounts_set).toBeUndefined();
    // Still schema-valid (both are .optional()).
    expect(() => shopifyOrderWebhookBodySchema.parse(body)).not.toThrow();
  });
});

describe('mapOrderNodeToWebhookBody — financial-status enum (the #1 correctness surface)', () => {
  // The confirmed live OrderDisplayFinancialStatus enum (Admin API 2026-04),
  // verified against shopify.dev. The adapter MUST cover exactly these.
  const LIVE_GRAPHQL_FINANCIAL_STATUSES = [
    'AUTHORIZED',
    'EXPIRED',
    'PAID',
    'PARTIALLY_PAID',
    'PARTIALLY_REFUNDED',
    'PENDING',
    'REFUNDED',
    'VOIDED',
  ];

  // The Prisma OrderFinancialStatus enum (lowercase) — the valid DB targets.
  const VALID_PRISMA_STATUSES = new Set([
    'pending',
    'authorized',
    'partially_paid',
    'paid',
    'partially_refunded',
    'refunded',
    'voided',
  ]);

  it('EXHAUSTIVENESS: the adapter map covers exactly the live GraphQL enum (no value un-handled)', () => {
    expect([...KNOWN_GRAPHQL_FINANCIAL_STATUSES].sort()).toEqual(
      [...LIVE_GRAPHQL_FINANCIAL_STATUSES].sort(),
    );
  });

  it('every live GraphQL value maps to a VALID Prisma status OR null — none can throw in parseFinancialStatus', () => {
    for (const gqlStatus of LIVE_GRAPHQL_FINANCIAL_STATUSES) {
      const body = mapOrderNodeToWebhookBody(
        makeOrderNode({ displayFinancialStatus: gqlStatus }),
        MERCHANT_ID,
      );
      const mapped = body!.financial_status;
      const okay =
        mapped === null || mapped === undefined || VALID_PRISMA_STATUSES.has(mapped);
      expect(okay, `${gqlStatus} → ${String(mapped)} must be a valid Prisma status or null`).toBe(
        true,
      );
    }
  });

  it('EXPIRED → null (excluded from the cohort — not revenue)', () => {
    const body = mapOrderNodeToWebhookBody(
      makeOrderNode({ displayFinancialStatus: 'EXPIRED' }),
      MERCHANT_ID,
    );
    expect(body!.financial_status).toBeNull();
  });

  it('the 7 webhook-equivalent values lowercase correctly', () => {
    const cases: [string, string][] = [
      ['AUTHORIZED', 'authorized'],
      ['PAID', 'paid'],
      ['PARTIALLY_PAID', 'partially_paid'],
      ['PARTIALLY_REFUNDED', 'partially_refunded'],
      ['PENDING', 'pending'],
      ['REFUNDED', 'refunded'],
      ['VOIDED', 'voided'],
    ];
    for (const [gql, expected] of cases) {
      const body = mapOrderNodeToWebhookBody(
        makeOrderNode({ displayFinancialStatus: gql }),
        MERCHANT_ID,
      );
      expect(body!.financial_status).toBe(expected);
    }
  });

  it('UNKNOWN value (future Shopify enum addition) → null WITH a loud warn (never silent-swallow)', () => {
    warnSpy.mockClear();
    const body = mapOrderNodeToWebhookBody(
      makeOrderNode({ displayFinancialStatus: 'SOME_NEW_STATUS' }),
      MERCHANT_ID,
    );
    expect(body!.financial_status).toBeNull();
    const loud = warnSpy.mock.calls.find(
      (c) => (c[0] as { unmappedFinancialStatus?: string }).unmappedFinancialStatus === 'SOME_NEW_STATUS',
    );
    expect(loud).toBeDefined();
  });

  it('null displayFinancialStatus → null (no warn — absence is not an unmapped value)', () => {
    warnSpy.mockClear();
    const body = mapOrderNodeToWebhookBody(
      makeOrderNode({ displayFinancialStatus: null }),
      MERCHANT_ID,
    );
    expect(body!.financial_status).toBeNull();
    const loud = warnSpy.mock.calls.find(
      (c) => 'unmappedFinancialStatus' in (c[0] as object),
    );
    expect(loud).toBeUndefined();
  });
});
