import { type OrderFinancialStatus, type OrderFulfillmentStatus, Prisma } from '@prisma/client';
import { ValidationError } from '@winback/errors';
import { getLogger } from '@winback/logger';

import {
  toShopifyCustomerGid,
  toShopifyLineItemGid,
  toShopifyOrderGid,
  toShopifyProductGid,
  toShopifyVariantGid,
} from '../gid.js';
import { parseMoneyToCents } from '../money.js';
import type { ShopifyMoneySet, ShopifyOrderWebhookBody } from '../webhook-bodies.js';

import { BaseRepository } from './base.js';

const log = getLogger('db.repo.order');

/**
 * Default number of recent purchased product titles surfaced to the winback
 * prompt (A4 §3 / `findRecentPurchasedTitles`). Matches the prompt builder's
 * `recentProducts.slice(0, 3)` and the `DEFAULT_TAKE` of the Shopify call this
 * replaced (Epic F §F-9 step 6b).
 */
const DEFAULT_RECENT_PRODUCTS_TAKE = 3;

/**
 * The CP-2 §Q1 qualifying-transition result. Computed by
 * `OrderRepository.upsertFromWebhook` and consumed by H1 when it adds
 * the inline `AttributionEvent` write at the call site.
 *
 *   - `paid_new`: new order arriving with `financial_status: paid`.
 *   - `paid_continued`: existing order transitioned to `paid` from a
 *      non-paid status (orders/updated).
 *   - `non_paid`: order with `financial_status` !== `paid` — not an
 *      attribution trigger.
 *   - `no_change`: order arrived with same `paid` status as already in DB
 *     (idempotent re-delivery; redundant update).
 */
export type QualifyingTransition = 'paid_new' | 'paid_continued' | 'non_paid' | 'no_change';

export interface UpsertOrderFromWebhookArgs {
  readonly merchantId: string;
  readonly body: ShopifyOrderWebhookBody;
  /**
   * Caller-provided transaction client. REQUIRED — not optional.
   *
   * Standalone calls outside a transaction would land outside tenant
   * scope (the drainer always wraps `withTenantScope + prisma.$transaction`
   * before calling here), and the Prisma extension would reject them
   * anyway. Required-tx surfaces caller mistakes at compile time.
   */
  readonly tx: Prisma.TransactionClient;
}

export interface UpsertOrderFromWebhookResult {
  readonly orderId: string;
  /**
   * Local Customer.id resolved from the embedded `body.customer` per P-10.
   * Null on guest checkout OR when the customer hasn't been ingested locally
   * yet (out-of-order webhook delivery — rule #22).  Surfaced here so the
   * Epic E session 2 scoring service can be invoked inline at the same call
   * site without a second customer lookup.
   */
  readonly customerId: string | null;
  readonly isNewOrder: boolean;
  readonly qualifyingTransition: QualifyingTransition;
  readonly previousFinancialStatus: OrderFinancialStatus | null;
}

/**
 * Repository for the Order + OrderLineItem tables — the typed write
 * chokepoint for ingest from Shopify orders/* webhooks.
 *
 * Per EPIC-E-FIELD-MAPPING.md: every Order field landed here comes from
 * a MAPPED row in the mapping doc. The field-mapping doc is the source
 * of truth; this code implements it.
 */
export class OrderRepository extends BaseRepository {
  /**
   * Upsert an Order + its OrderLineItem rows from a Shopify webhook body.
   * Atomic — the Order upsert and all line item upserts happen inside the
   * caller's transaction.
   *
   * Idempotent on `(merchantId, shopifyOrderId)` (the composite unique).
   *
   * CP-2 §Q1 qualifying-transition result is returned for H1 to consume
   * at the AttributionEvent write site (H1's commit adds that write in
   * the drainer handler without a second DB read).
   *
   * ⚠ TX INVARIANT (load-bearing — see comment in body):
   * the `tx.order.findUnique` for the prior financial-status read AND
   * the `tx.order.upsert` MUST use the same `args.tx` argument. Using
   * `this.prisma` for the read would be a phantom read outside the
   * caller's transaction, and the qualifying-transition computation
   * would be meaningless under any concurrent load — two concurrent
   * orders/updated webhooks for the same order would BOTH compute
   * `paid_new` from the same pre-write null read. Easy mistake; tests
   * cover the contract via the unit suite.
   */
  async upsertFromWebhook(
    args: UpsertOrderFromWebhookArgs,
  ): Promise<UpsertOrderFromWebhookResult> {
    const { merchantId, body, tx } = args;

    // 1. GID wrap. ShopifyOrderWebhookBodySchema requires body.id; if zod
    //    let a non-numeric value through, the wrap returns null and we
    //    throw — caller (drainer) treats as non-retryable.
    const shopifyOrderId = toShopifyOrderGid(body.id);
    if (shopifyOrderId === null) {
      throw new ValidationError(`Order webhook body.id is not a valid numeric id`, {
        code: 'order.invalid_id',
        fields: { received: String(body.id) },
      });
    }

    // 2. Prior-status read inside the SAME tx as the upsert (see ⚠ TX
    //    INVARIANT in the method docstring). Returns null if the order
    //    didn't exist locally.
    const existing = await tx.order.findUnique({
      where: { merchantId_shopifyOrderId: { merchantId, shopifyOrderId } },
      select: { id: true, financialStatus: true },
    });
    const previousFinancialStatus: OrderFinancialStatus | null =
      existing?.financialStatus ?? null;

    // 3. Validate + extract enums + parse money.
    const newFinancialStatus = parseFinancialStatus(body.financial_status);
    const newFulfillmentStatus = parseFulfillmentStatus(body.fulfillment_status);

    const subtotalAmountCents = parseMoneyToCents(body.subtotal_price_set.shop_money.amount);
    const totalAmountCents = parseMoneyToCents(body.total_price_set.shop_money.amount);
    const totalTaxCents = moneyOrZero(body.total_tax_set);
    const totalDiscountCents = moneyOrZero(body.total_discounts_set);

    const presentmentTotalCents =
      body.presentment_currency !== null && body.presentment_currency !== undefined
        ? parseMoneyToCents(body.total_price_set.presentment_money.amount)
        : null;

    // 4. Customer FK lookup (per P-10).
    const customerId = await resolveCustomerFk(tx, merchantId, body);

    // 5. Compute qualifying transition.
    const qualifyingTransition = computeQualifyingTransition(
      previousFinancialStatus,
      newFinancialStatus,
    );

    // 6. Build the create/update data.
    const sharedFields = {
      shopifyOrderNumber: body.name ?? null,
      isTest: body.test,
      financialStatus: newFinancialStatus,
      fulfillmentStatus: newFulfillmentStatus,
      customerId,
      currency: body.currency,
      presentmentCurrency: body.presentment_currency ?? null,
      subtotalAmountCents,
      totalAmountCents,
      totalTaxCents,
      totalDiscountCents,
      presentmentTotalCents,
      placedAt: new Date(body.created_at),
      cancelledAt: body.cancelled_at !== null && body.cancelled_at !== undefined
        ? new Date(body.cancelled_at)
        : null,
      shopifyProcessedAt:
        body.processed_at !== null && body.processed_at !== undefined
          ? new Date(body.processed_at)
          : null,
      shopifyUpdatedAt: new Date(body.updated_at),
    };

    // 7. Order upsert.
    const upserted = await tx.order.upsert({
      where: { merchantId_shopifyOrderId: { merchantId, shopifyOrderId } },
      create: {
        merchantId,
        shopifyOrderId,
        ...sharedFields,
      },
      update: sharedFields,
      select: { id: true },
    });
    const orderId = upserted.id;

    // 8. OrderLineItem reconciliation — upsert-only (per session-1
    //    decision; documented in EPIC-E-FIELD-MAPPING.md plan). Missing
    //    line items in subsequent webhooks leave stale rows behind;
    //    flagged as a known limitation for M10 revisit if real merchants
    //    report drift.
    let missingProducts = 0;
    let missingVariants = 0;

    if (body.line_items.length > 0) {
      const lookups = await batchedFkLookups(tx, merchantId, body.line_items);

      for (const lineItem of body.line_items) {
        const shopifyLineItemId = toShopifyLineItemGid(lineItem.id);
        if (shopifyLineItemId === null) {
          throw new ValidationError(`Line item id is not a valid numeric id`, {
            code: 'order.line_item.invalid_id',
            fields: { received: String(lineItem.id), orderId },
          });
        }

        let productId: string | null = null;
        if (lineItem.product_id !== null && lineItem.product_id !== undefined) {
          const productGid = toShopifyProductGid(lineItem.product_id);
          if (productGid !== null) {
            productId = lookups.productMap.get(productGid) ?? null;
            if (productId === null) missingProducts++;
          }
        }

        let productVariantId: string | null = null;
        if (lineItem.variant_id !== null && lineItem.variant_id !== undefined) {
          const variantGid = toShopifyVariantGid(lineItem.variant_id);
          if (variantGid !== null) {
            productVariantId = lookups.variantMap.get(variantGid) ?? null;
            if (productVariantId === null) missingVariants++;
          }
        }

        const lineItemShared = {
          merchantId,
          productId,
          productVariantId,
          title: lineItem.title,
          quantity: lineItem.quantity,
          unitPriceCents: parseMoneyToCents(lineItem.price_set.shop_money.amount),
          // Per the field mapping doc footer: OrderLineItem.currency
          // sourced from the parent Order's currency (Shopify never
          // varies it per line item).
          currency: body.currency,
        };

        await tx.orderLineItem.upsert({
          // S-4: merchantId-prefixed composite key.  `lineItemShared`
          // already carries merchantId (built at line ~218).  The Prisma
          // extension can now validate the lookup against the active
          // tenant scope before the row reads.
          where: {
            merchantId_orderId_shopifyLineItemId: {
              merchantId,
              orderId,
              shopifyLineItemId,
            },
          },
          create: {
            orderId,
            shopifyLineItemId,
            ...lineItemShared,
          },
          update: lineItemShared,
        });
      }
    }

    // 9. Per-Order summary log for missing line-item FKs (decision D
    //    from the batch 3 sketch — one log per Order, not per FK).
    if (missingProducts > 0 || missingVariants > 0) {
      log.debug(
        {
          merchantId,
          orderId,
          shopifyOrderId,
          missingProducts,
          missingVariants,
          totalLineItems: body.line_items.length,
        },
        'order: line items reference product/variant FKs not present locally — leaving null per P-10-style policy',
      );
    }

    return {
      orderId,
      customerId,
      isNewOrder: existing === null,
      qualifyingTransition,
      previousFinancialStatus,
    };
  }

  /**
   * The customer's recently-purchased product titles for the winback prompt's
   * context block (A4 / POST-EPIC-F §3).
   *
   * Reads local Postgres (`Order` + `OrderLineItem`) instead of the Shopify
   * Admin GraphQL API the Epic-F handler originally called (§F-9 step 6b). The
   * titles are denormalised onto `OrderLineItem.title` at ingest time — BOTH
   * the live `orders/create` webhook AND the operator order-backfill write it
   * through `upsertFromWebhook` — so the local query returns the same titles
   * the API would, with no Shopify dependency, latency, or leaky-bucket token.
   *
   * Selection (the A4 §3 decisions, recorded here):
   *   - Qualifying orders: `financialStatus IN ('paid','partially_paid')` AND
   *     `isTest = false`. The isTest exclusion is an INTENTIONAL divergence
   *     from the swapped-out Shopify call (which did not filter test orders):
   *     a customer's dev-store TEST purchases must not seed a real winback.
   *     Matches the scoring cohort's `isTest = false` posture.
   *   - Ordering: most-recent first by `COALESCE("shopifyProcessedAt",
   *     "placedAt") DESC` — the SAME recency expression the scoring engine
   *     uses (`CustomerScoreRepository.readCohort`), so "recent" means the
   *     same thing in the prompt as in scoring. SUPERSEDES §3's literal
   *     `placedAt DESC`. (This COALESCE key is why the method is raw SQL —
   *     Prisma's `orderBy` sorts NULLs first on DESC and cannot express it.)
   *   - One "primary" line item per order: the lexicographically-lowest
   *     `shopifyLineItemId` (`DISTINCT ON`). A deterministic LOCAL
   *     APPROXIMATION of Shopify's "first line item", not an exact match —
   *     recent-products is flavor context, not load-bearing.
   *   - At most `take` (default 3) titles, matching the prompt builder's slice.
   *
   * Returns `[]` when the customer has no qualifying orders — the normal
   * graceful path (the prompt omits the recent-purchases section). A DB error
   * PROPAGATES (the drainer's per-row try/catch markFails the event); unlike
   * the old external Shopify call there is no swallow-and-continue, because a
   * local read failing is a real fault, not a transient external degrade.
   *
   * Raw SQL via `queryRawScoped` (BaseRepository) — the sanctioned entry point
   * that asserts the active tenant scope matches `merchantId` before executing.
   * Read-only and runs OUTSIDE any tx (the §F-9 handler calls it before its
   * STEP 8 completion tx), so it binds to `this.prisma`, not a caller tx.
   */
  async findRecentPurchasedTitles(args: {
    merchantId: string;
    customerId: string;
    take?: number;
  }): Promise<readonly string[]> {
    const { merchantId, customerId } = args;
    const take = args.take ?? DEFAULT_RECENT_PRODUCTS_TAKE;

    const rows = await this.queryRawScoped<{ title: string }>(
      merchantId,
      Prisma.sql`
        SELECT sub.title
        FROM (
          SELECT DISTINCT ON (o."id")
                 o."id" AS order_id,
                 COALESCE(o."shopifyProcessedAt", o."placedAt") AS recency,
                 li."title" AS title
          FROM "Order" o
          JOIN "OrderLineItem" li
            ON li."orderId" = o."id" AND li."merchantId" = o."merchantId"
          WHERE o."merchantId" = ${merchantId}
            AND o."customerId" = ${customerId}
            AND o."isTest" = false
            AND o."financialStatus"::text IN ('paid', 'partially_paid')
          ORDER BY o."id", li."shopifyLineItemId" ASC
        ) sub
        ORDER BY sub.recency DESC
        LIMIT ${take}
      `,
    );

    return rows.map((r) => r.title);
  }
}

// ---------------------------------------------------------------------------
// File-private helpers
// ---------------------------------------------------------------------------

/**
 * Returns BigInt cents for an optional `_set` money composite, defaulting
 * to `0n` when the set is absent. Per EPIC-E-FIELD-MAPPING.md row #28/#30
 * + the optional-`_set` decision in webhook-bodies.ts: Shopify's 2026-04
 * docs don't explicitly state field presence for zero-tax / zero-discount
 * orders, so the zod schema accepts undefined. The repository must
 * default to 0n — matching `Order.totalTaxCents` / `Order.totalDiscountCents`
 * column `@default(0)`. Named helper rather than inline ternaries makes
 * the contract visible at every call site.
 */
function moneyOrZero(set: ShopifyMoneySet | undefined): bigint {
  if (set === undefined) return 0n;
  return parseMoneyToCents(set.shop_money.amount);
}

const VALID_FINANCIAL_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'authorized',
  'partially_paid',
  'paid',
  'partially_refunded',
  'refunded',
  'voided',
]);

const VALID_FULFILLMENT_STATUSES: ReadonlySet<string> = new Set([
  'fulfilled',
  'partial',
  'unfulfilled',
  'restocked',
]);

function parseFinancialStatus(value: string | null | undefined): OrderFinancialStatus | null {
  if (value === null || value === undefined) return null;
  if (!VALID_FINANCIAL_STATUSES.has(value)) {
    throw new ValidationError(`Unknown Shopify financial_status: ${JSON.stringify(value)}`, {
      code: 'order.invalid_financial_status',
      fields: { received: value },
    });
  }
  return value as OrderFinancialStatus;
}

function parseFulfillmentStatus(
  value: string | null | undefined,
): OrderFulfillmentStatus | null {
  if (value === null || value === undefined) return null;
  if (!VALID_FULFILLMENT_STATUSES.has(value)) {
    // Asymmetry with parseFinancialStatus (which throws): fulfillment
    // status is informational, NOT gate-critical for CP-2 attribution.
    // A new Shopify fulfillment status (Shopify has added enum values
    // without notice historically) should NOT DLQ valid orders. Log at
    // warn level — operator sees that Shopify drift happened, schema
    // enum can be extended in a follow-up. financial_status keeps
    // throwing because it gates the qualifying-transition check.
    log.warn(
      { received: value },
      'unknown Shopify fulfillment_status — storing as null, schema enum may need extension',
    );
    return null;
  }
  return value as OrderFulfillmentStatus;
}

/**
 * Computes the CP-2 §Q1 qualifying-transition result from the previous
 * + new financial_status. Pure function — easy to unit-test.
 */
function computeQualifyingTransition(
  previousFinancialStatus: OrderFinancialStatus | null,
  newFinancialStatus: OrderFinancialStatus | null,
): QualifyingTransition {
  if (newFinancialStatus !== 'paid') return 'non_paid';
  if (previousFinancialStatus === null) return 'paid_new';
  if (previousFinancialStatus !== 'paid') return 'paid_continued';
  return 'no_change';
}

/**
 * Resolve the Customer FK from the embedded `body.customer` object.
 * Per P-10: if `body.customer` is null/absent (guest checkout) OR if
 * the customer doesn't exist locally yet (out-of-order webhook
 * delivery), return null. A debug log surfaces the orphan-order case
 * for operator visibility.
 */
async function resolveCustomerFk(
  tx: Prisma.TransactionClient,
  merchantId: string,
  body: ShopifyOrderWebhookBody,
): Promise<string | null> {
  if (body.customer === null || body.customer === undefined) return null;
  const shopifyCustomerId = toShopifyCustomerGid(body.customer.id);
  if (shopifyCustomerId === null) return null;
  const found = await tx.customer.findUnique({
    where: { merchantId_shopifyCustomerId: { merchantId, shopifyCustomerId } },
    select: { id: true },
  });
  if (found === null) {
    log.debug(
      { merchantId, shopifyCustomerId },
      'order: customer FK not present locally; setting customerId=null (out-of-order delivery per rule #22)',
    );
    return null;
  }
  return found.id;
}

interface FkLookupResult {
  readonly productMap: ReadonlyMap<string, string>;
  readonly variantMap: ReadonlyMap<string, string>;
}

/**
 * Batched FK lookup for line items — avoids N+1 queries when the order
 * has many line items.
 */
async function batchedFkLookups(
  tx: Prisma.TransactionClient,
  merchantId: string,
  lineItems: readonly {
    product_id?: number | string | null | undefined;
    variant_id?: number | string | null | undefined;
  }[],
): Promise<FkLookupResult> {
  const productGids = new Set<string>();
  const variantGids = new Set<string>();

  for (const item of lineItems) {
    if (item.product_id !== null && item.product_id !== undefined) {
      const gid = toShopifyProductGid(item.product_id);
      if (gid !== null) productGids.add(gid);
    }
    if (item.variant_id !== null && item.variant_id !== undefined) {
      const gid = toShopifyVariantGid(item.variant_id);
      if (gid !== null) variantGids.add(gid);
    }
  }

  const [products, variants] = await Promise.all([
    productGids.size > 0
      ? tx.product.findMany({
          where: { merchantId, shopifyProductId: { in: Array.from(productGids) } },
          select: { id: true, shopifyProductId: true },
        })
      : Promise.resolve([]),
    variantGids.size > 0
      ? tx.productVariant.findMany({
          where: { merchantId, shopifyVariantId: { in: Array.from(variantGids) } },
          select: { id: true, shopifyVariantId: true },
        })
      : Promise.resolve([]),
  ]);

  return {
    productMap: new Map(products.map((p) => [p.shopifyProductId, p.id])),
    variantMap: new Map(variants.map((v) => [v.shopifyVariantId, v.id])),
  };
}
