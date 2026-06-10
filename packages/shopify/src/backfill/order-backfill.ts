import type { Prisma } from '@prisma/client';
import { BACKFILL_RESOURCES, type BackfillResource } from '@winback/contracts';
import {
  OrderRepository,
  type ShopifyOrderWebhookBody,
  type WinbackPrisma,
  shopifyOrderWebhookBodySchema,
} from '@winback/db';
import { getLogger } from '@winback/logger';

import type { AdminClient } from '../admin/client.js';

import { extractNumericIdFromGid } from './customer-backfill.js';
import type { PageFetcher, PageProcessor, ResourcePage } from './types.js';

const log = getLogger('shopify.backfill.order');

/** Resource identifier for this fetcher/processor pair. */
export const ORDER_BACKFILL_RESOURCE: BackfillResource = BACKFILL_RESOURCES.orders;

/**
 * Line-item cap per order. Shopify's `lineItems` connection is fetched
 * `first: 250` (the per-connection ceiling for a single query) and NOT
 * sub-paginated. An order with >250 line items loses the overflow.
 *
 * WHY THIS IS SAFE: line items are SCORING-IRRELEVANT. `readCohort`
 * (`packages/db/src/repositories/customer-score.repository.ts`) aggregates
 * the `Order` table ONLY — `totalAmountCents` (M), `COUNT(*)` (F),
 * `placedAt` (R), `customerId` — never `OrderLineItem`. So a truncated
 * line-item set cannot affect any RFM score. Line items are best-effort
 * here for future product-level features (Epic G/H); a future dev building
 * on line-item data must know backfilled orders carry incomplete-by-design
 * line items (this cap + null product/variant FKs because products aren't
 * backfilled). Sub-pagination is deferred until a product feature needs it.
 */
const LINE_ITEMS_PER_ORDER = 250;

// ---------------------------------------------------------------------------
// GraphQL node shape (Admin API 2026-04). Only the fields we map are
// declared; the query requests exactly these.
// ---------------------------------------------------------------------------

interface GraphQLMoneyBag {
  readonly shopMoney: { readonly amount: string; readonly currencyCode: string };
  readonly presentmentMoney: { readonly amount: string; readonly currencyCode: string };
}

interface ShopifyOrderLineItemNode {
  readonly id: string; // gid://shopify/LineItem/<n>
  readonly title: string;
  readonly quantity: number;
  readonly originalUnitPriceSet: GraphQLMoneyBag;
  readonly product: { readonly id: string } | null;
  readonly variant: { readonly id: string } | null;
}

export interface ShopifyOrderNode {
  readonly id: string; // gid://shopify/Order/<n>
  readonly name: string | null;
  readonly test: boolean;
  readonly displayFinancialStatus: string | null; // OrderDisplayFinancialStatus enum (UPPERCASE)
  readonly displayFulfillmentStatus: string | null; // OrderDisplayFulfillmentStatus enum (UPPERCASE)
  readonly currencyCode: string;
  readonly presentmentCurrencyCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly processedAt: string | null;
  readonly cancelledAt: string | null;
  readonly subtotalPriceSet: GraphQLMoneyBag;
  readonly totalPriceSet: GraphQLMoneyBag;
  readonly totalTaxSet: GraphQLMoneyBag | null;
  readonly totalDiscountsSet: GraphQLMoneyBag | null;
  readonly customer: { readonly id: string } | null;
  readonly lineItems: { readonly nodes: readonly ShopifyOrderLineItemNode[] };
}

interface RawOrdersResponse {
  orders?: {
    pageInfo: { endCursor: string | null; hasNextPage: boolean };
    nodes: ShopifyOrderNode[];
  };
}

const ORDERS_PAGE_QUERY = /* GraphQL */ `
  query OrdersPage($first: Int!, $after: String, $lineItemsFirst: Int!) {
    orders(first: $first, after: $after, sortKey: ID) {
      pageInfo { endCursor hasNextPage }
      nodes {
        id
        name
        test
        displayFinancialStatus
        displayFulfillmentStatus
        currencyCode
        presentmentCurrencyCode
        createdAt
        updatedAt
        processedAt
        cancelledAt
        subtotalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
        totalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
        totalTaxSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
        totalDiscountsSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
        customer { id }
        lineItems(first: $lineItemsFirst) {
          nodes {
            id
            title
            quantity
            originalUnitPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
            product { id }
            variant { id }
          }
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Enum mapping — financial status. The #1 silent-corruption surface.
//
// `parseFinancialStatus` (the repo) THROWS on any value outside the Prisma
// `OrderFinancialStatus` enum (lowercase). The GraphQL
// `OrderDisplayFinancialStatus` enum is UPPERCASE and has one extra value
// (`EXPIRED`) the Prisma enum lacks. So this map is EXHAUSTIVE over the
// confirmed 2026-04 enum (8 values) + LOUD-default-to-null for any future
// 9th value Shopify adds — never silently swallow an unmapped value.
//
// Confirmed against the live 2026-04 schema (OrderDisplayFinancialStatus):
//   AUTHORIZED, EXPIRED, PAID, PARTIALLY_PAID, PARTIALLY_REFUNDED,
//   PENDING, REFUNDED, VOIDED.
//
// EXPIRED -> null: not a Prisma enum value; an expired (abandoned-payment)
// order is not revenue. A null financialStatus is EXCLUDED from the cohort
// (`readCohort` filters `WHERE financialStatus = 'paid'`; SQL `null = 'paid'`
// is false) — exactly the right treatment.
// ---------------------------------------------------------------------------

/** Every confirmed GraphQL value → its Prisma-enum lowercase, or null. */
const FINANCIAL_STATUS_MAP: Readonly<Record<string, string | null>> = {
  AUTHORIZED: 'authorized',
  EXPIRED: null,
  PAID: 'paid',
  PARTIALLY_PAID: 'partially_paid',
  PARTIALLY_REFUNDED: 'partially_refunded',
  PENDING: 'pending',
  REFUNDED: 'refunded',
  VOIDED: 'voided',
};

/** Exported for the exhaustiveness test (assert it covers the live enum). */
export const KNOWN_GRAPHQL_FINANCIAL_STATUSES = Object.keys(FINANCIAL_STATUS_MAP);

function mapFinancialStatus(
  value: string | null,
  ctx: { merchantId: string; orderGid: string },
): string | null {
  if (value === null) return null;
  if (Object.prototype.hasOwnProperty.call(FINANCIAL_STATUS_MAP, value)) {
    return FINANCIAL_STATUS_MAP[value] ?? null;
  }
  // LOUD default-to-null: an unmapped value (Shopify added a new enum value).
  // Visible in the backfill logs, NOT silently vanished from the cohort.
  log.warn(
    { merchantId: ctx.merchantId, orderGid: ctx.orderGid, unmappedFinancialStatus: value },
    'order backfill: unmapped GraphQL displayFinancialStatus — storing null (excluded from cohort); FINANCIAL_STATUS_MAP needs an entry',
  );
  return null;
}

// Fulfillment status is INFORMATIONAL (not cohort-used; `parseFulfillmentStatus`
// returns null on unknown rather than throwing). Best-effort lowercase map of
// the webhook-equivalent values; anything else → null (the repo logs it).
const FULFILLMENT_STATUS_MAP: Readonly<Record<string, string | null>> = {
  FULFILLED: 'fulfilled',
  PARTIALLY_FULFILLED: 'partial',
  UNFULFILLED: 'unfulfilled',
  RESTOCKED: 'restocked',
};

function mapFulfillmentStatus(value: string | null): string | null {
  if (value === null) return null;
  return FULFILLMENT_STATUS_MAP[value] ?? null;
}

// ---------------------------------------------------------------------------
// Adapter: GraphQL order node → ShopifyOrderWebhookBody.
//
// SINGLE SOURCE OF UPSERT TRUTH: the adapter produces the exact webhook body
// shape that `OrderRepository.upsertFromWebhook` consumes, so a backfilled
// order takes the IDENTICAL DB path as a webhook order — money parsing, FK
// resolution, line-item handling, qualifying-transition — and the cohort
// cannot diverge by ingestion source.
//
// Returns null when the order's own GID is malformed (skip + the processor
// logs); a malformed order id can't be upserted.
// ---------------------------------------------------------------------------

function moneyBagToWebhookSet(bag: GraphQLMoneyBag): ShopifyOrderWebhookBody['total_price_set'] {
  return {
    shop_money: { amount: bag.shopMoney.amount, currency_code: bag.shopMoney.currencyCode },
    presentment_money: {
      amount: bag.presentmentMoney.amount,
      currency_code: bag.presentmentMoney.currencyCode,
    },
  };
}

export function mapOrderNodeToWebhookBody(
  node: ShopifyOrderNode,
  merchantId: string,
): ShopifyOrderWebhookBody | null {
  const orderNumericId = extractNumericIdFromGid(node.id);
  if (orderNumericId === null) {
    log.warn(
      { merchantId, malformedOrderGid: node.id },
      'order backfill: skipping order with malformed GID',
    );
    return null;
  }

  // Customer FK (guest order → null). resolveCustomerFk in the repo reads
  // `body.customer.id`; we supply the numeric extracted from the GID.
  const customerNumericId =
    node.customer !== null ? extractNumericIdFromGid(node.customer.id) : null;

  const lineItems = node.lineItems.nodes
    .map((li) => {
      const liNumericId = extractNumericIdFromGid(li.id);
      if (liNumericId === null) {
        log.warn(
          { merchantId, orderGid: node.id, malformedLineItemGid: li.id },
          'order backfill: skipping line item with malformed GID',
        );
        return null;
      }
      const productNumericId =
        li.product !== null ? extractNumericIdFromGid(li.product.id) : null;
      const variantNumericId =
        li.variant !== null ? extractNumericIdFromGid(li.variant.id) : null;
      return {
        id: liNumericId,
        product_id: productNumericId,
        variant_id: variantNumericId,
        title: li.title,
        quantity: li.quantity,
        price: li.originalUnitPriceSet.shopMoney.amount,
        price_set: moneyBagToWebhookSet(li.originalUnitPriceSet),
      };
    })
    .filter((li): li is NonNullable<typeof li> => li !== null);

  const body: ShopifyOrderWebhookBody = {
    id: orderNumericId,
    name: node.name,
    test: node.test,
    financial_status: mapFinancialStatus(node.displayFinancialStatus, {
      merchantId,
      orderGid: node.id,
    }),
    fulfillment_status: mapFulfillmentStatus(node.displayFulfillmentStatus),
    customer: customerNumericId !== null ? { id: customerNumericId } : null,
    currency: node.currencyCode,
    presentment_currency: node.presentmentCurrencyCode,
    subtotal_price_set: moneyBagToWebhookSet(node.subtotalPriceSet),
    total_price_set: moneyBagToWebhookSet(node.totalPriceSet),
    total_tax_set: node.totalTaxSet !== null ? moneyBagToWebhookSet(node.totalTaxSet) : undefined,
    total_discounts_set:
      node.totalDiscountsSet !== null ? moneyBagToWebhookSet(node.totalDiscountsSet) : undefined,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    processed_at: node.processedAt,
    cancelled_at: node.cancelledAt,
    line_items: lineItems,
  };

  return body;
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

/**
 * Page fetcher for the `orders/` backfill. Mirrors `CustomerPageFetcher`:
 * every call goes through `AdminClient.graphql` (CostTracker-gated, C5).
 */
export class OrderPageFetcher implements PageFetcher<ShopifyOrderNode> {
  constructor(private readonly client: AdminClient) {}

  async fetch(args: {
    merchantId: string;
    cursor: string | null;
    pageSize: number;
  }): Promise<ResourcePage<ShopifyOrderNode>> {
    const data = await this.client.graphql<RawOrdersResponse>(args.merchantId, {
      query: ORDERS_PAGE_QUERY,
      variables: {
        first: args.pageSize,
        after: args.cursor,
        lineItemsFirst: LINE_ITEMS_PER_ORDER,
      },
      // Orders carry nested lineItems → heavier than customers. Conservative
      // pre-flight cost hint (base + per-order line-item cost).
      estimatedCost: Math.max(20, Math.ceil(args.pageSize / 2)),
    });
    const conn = data.orders;
    if (conn === undefined) {
      return { items: [], endCursor: null, hasNextPage: false };
    }
    return {
      items: conn.nodes,
      endCursor: conn.pageInfo.endCursor,
      hasNextPage: conn.pageInfo.hasNextPage,
    };
  }
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

/**
 * Page processor: maps each GraphQL order node → webhook body, validates it
 * through `shopifyOrderWebhookBodySchema` (fail-loud at the adapter boundary,
 * never silent-wrong in an Order row), then upserts via
 * `OrderRepository.upsertFromWebhook` USING THE PASSED `tx`.
 *
 * SILENT BY CONSTRUCTION (no recompute, no emit). The per-order RFM
 * `recompute` lives in the drainer's `handleOrderEvent` HANDLER
 * (`apps/drainer/src/handlers/order.ts`), NOT in
 * `OrderRepository.upsertFromWebhook` (the repo). This processor calls the
 * REPO directly, so it never triggers scoring — a backfill of N orders does
 * NOT produce N recomputes (no O(N²), no storm). Scoring happens ONCE
 * afterward via the operator's `cli:scoring:bulk-rescore`.
 */
export class OrderPageProcessor implements PageProcessor<ShopifyOrderNode> {
  async processItems(args: {
    tx: Prisma.TransactionClient;
    merchantId: string;
    items: readonly ShopifyOrderNode[];
  }): Promise<void> {
    // `OrderRepository` types its constructor arg as `WinbackPrisma`, but
    // `upsertFromWebhook` uses ONLY the explicit `tx` argument (it never
    // dereferences the constructor client — see the order.repository.ts
    // line-87 phantom-read note). So passing the page tx here is correct;
    // the cast bridges the Prisma-5 extended-client typing gap, same as the
    // drainer handlers' `extendedTx as Prisma.TransactionClient` casts.
    const orderRepo = new OrderRepository(args.tx as unknown as WinbackPrisma);
    for (const node of args.items) {
      const mapped = mapOrderNodeToWebhookBody(node, args.merchantId);
      if (mapped === null) {
        continue; // malformed order GID — already logged in the adapter.
      }
      // Validate the hand-mapped body against the canonical schema before
      // the upsert. Catches any adapter mapping bug at the boundary.
      const body = shopifyOrderWebhookBodySchema.parse(mapped);
      await orderRepo.upsertFromWebhook({ merchantId: args.merchantId, body, tx: args.tx });
    }
  }
}
