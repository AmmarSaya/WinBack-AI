import {
  MAX_OUTBOX_ATTEMPTS,
  OUTBOX_EVENTS,
  type OutboxEventType,
} from '@winback/contracts';
import {
  AuditLogRepository,
  CustomerScoreRepository,
  CustomerScoreService,
  withSystemScope,
  withTenantScope,
  type WinbackPrisma,
} from '@winback/db';
import {
  assertRead,
  createTestMerchant,
  getTestClient,
  resetDb,
} from '@winback/db/test-utils';
import { ValidationError } from '@winback/errors';
import {
  BackfillRunner,
  ORDER_BACKFILL_RESOURCE,
  OrderPageProcessor,
  type PageFetcher,
  type ResourcePage,
  type ShopifyOrderNode,
} from '@winback/shopify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { DrainerContext } from '../../src/context.js';
import { runDrainTick } from '../../src/drainer.js';

const SHOP = 'drainer-integration.myshopify.com';

/**
 * Drainer integration suite — real Postgres, real `runDrainTick`.
 *
 * Tests cover three classes:
 *   1. Real-ingest-shape happy paths (the C-1 regression-lock channel —
 *      payloads MUST match what apps/web/app/services/webhook-ingest.server.ts
 *      writes at lines 142-154; any future producer/consumer shape drift
 *      fails here loudly).
 *   2. MARK_BEFORE_INVOKE policy (gdpr.shop_redacted happy path against
 *      the real processor + Phase 2 deferred-failure marker via custom
 *      dispatch).
 *   3. DLQ logic (non-retryable, retryable below ceiling, retryable AT
 *      ceiling — locks the D4 `row.attempts + 1 >= MAX` off-by-one fix).
 *
 * Queues are stubbed at the context level — no current in-scope handler
 * enqueues. If a future handler does, the stub's `.add` would be called
 * unexpectedly; TS would catch the type mismatch first, then the test
 * surface gets extended deliberately. Shopify HTTP is NOT mocked because
 * the handlers tested here (order stubs, GDPR, merchant.uninstalled)
 * don't make outbound calls. `merchant.installed` (which does) is
 * deferred to a follow-up session per the design choice.
 */

function makeCtx(prisma?: WinbackPrisma): DrainerContext {
  return {
    prisma: prisma ?? getTestClient(),
    queues: {} as DrainerContext['queues'],
    shopifyConfig: {} as DrainerContext['shopifyConfig'],
  };
}

/**
 * Insert an OutboxEvent matching the production producer shape. The
 * payload mirrors what apps/web/app/services/webhook-ingest.server.ts
 * writes for every webhook delivery — `{ topic, webhookId, body }` with
 * `body` being the raw Shopify webhook payload. Sync the keys with that
 * call site if a producer change is ever made (rule of thumb: bump the
 * `@v<n>` suffix on the outbox event type when shape changes).
 *
 * Returns the inserted row's id.
 */
async function seedOutboxEvent(
  merchantId: string,
  type: OutboxEventType,
  payload: Record<string, unknown>,
  options: { attempts?: number } = {},
): Promise<string> {
  return withSystemScope('test.setup_outbox', async () => {
    const row = await getTestClient().outboxEvent.create({
      data: {
        merchantId,
        type,
        payload,
        attempts: options.attempts ?? 0,
      },
      select: { id: true },
    });
    return row.id;
  });
}

const ZERO_MONEY_SET = {
  shop_money: { amount: '0.00', currency_code: 'USD' },
  presentment_money: { amount: '0.00', currency_code: 'USD' },
};

/**
 * Producer-shaped payload for an order event. Matches what
 * apps/web/app/services/webhook-ingest.server.ts writes — full body
 * satisfying `shopifyOrderWebhookBodySchema` (post-batch-2 tight schema).
 * `bodyOverrides` lets tests target specific MAPPED fields.
 */
function orderPayload(args: {
  topic: 'orders/create' | 'orders/updated';
  webhookId: string;
  shopifyOrderId: number | string;
  bodyOverrides?: Record<string, unknown>;
}): Record<string, unknown> {
  const body = {
    id: args.shopifyOrderId,
    financial_status: 'paid',
    currency: 'USD',
    subtotal_price_set: {
      shop_money: { amount: '100.00', currency_code: 'USD' },
      presentment_money: { amount: '100.00', currency_code: 'USD' },
    },
    total_price_set: {
      shop_money: { amount: '110.00', currency_code: 'USD' },
      presentment_money: { amount: '110.00', currency_code: 'USD' },
    },
    total_tax_set: {
      shop_money: { amount: '10.00', currency_code: 'USD' },
      presentment_money: { amount: '10.00', currency_code: 'USD' },
    },
    total_discounts_set: ZERO_MONEY_SET,
    created_at: '2026-05-19T12:00:00Z',
    updated_at: '2026-05-19T12:00:00Z',
    line_items: [],
    ...(args.bodyOverrides ?? {}),
  };
  return { topic: args.topic, webhookId: args.webhookId, body };
}

/**
 * Producer-shaped payload for a customer event. Full body satisfying
 * `shopifyCustomerWebhookBodySchema`.
 */
function customerPayload(args: {
  topic?: 'customers/create' | 'customers/update' | 'customers/delete';
  webhookId: string;
  shopifyCustomerId: number | string;
  bodyOverrides?: Record<string, unknown>;
}): Record<string, unknown> {
  const body = {
    id: args.shopifyCustomerId,
    email: 'test@example.com',
    created_at: '2026-05-19T12:00:00Z',
    updated_at: '2026-05-19T12:00:00Z',
    ...(args.bodyOverrides ?? {}),
  };
  return {
    topic: args.topic ?? 'customers/create',
    webhookId: args.webhookId,
    body,
  };
}

/**
 * Seeds a Product + ProductVariant for tests that exercise line-item
 * FK resolution. Returns the local cuids of both.
 */
async function createTestProductWithVariant(args: {
  merchantId: string;
  shopifyProductId: string;
  shopifyVariantId: string;
}): Promise<{ productId: string; variantId: string }> {
  return withSystemScope('test.setup_product', async () => {
    const product = await getTestClient().product.create({
      data: {
        merchantId: args.merchantId,
        shopifyProductId: args.shopifyProductId,
        title: 'Test Product',
        status: 'active',
      },
      select: { id: true },
    });
    const variant = await getTestClient().productVariant.create({
      data: {
        merchantId: args.merchantId,
        productId: product.id,
        shopifyVariantId: args.shopifyVariantId,
        title: 'Test Variant',
        priceCents: 1000n,
        currency: 'USD',
      },
      select: { id: true },
    });
    return { productId: product.id, variantId: variant.id };
  });
}

/**
 * Seeds a Customer row directly (bypasses the customers/* webhook flow)
 * so tests that need a pre-existing customer for FK resolution can
 * set one up without going through the drainer twice.
 */
async function createTestCustomer(args: {
  merchantId: string;
  shopifyCustomerId: string;
  email?: string;
}): Promise<string> {
  return withSystemScope('test.setup_customer', async () => {
    const customer = await getTestClient().customer.create({
      data: {
        merchantId: args.merchantId,
        shopifyCustomerId: args.shopifyCustomerId,
        email: args.email ?? 'pre-seeded@example.com',
      },
      select: { id: true },
    });
    return customer.id;
  });
}

/**
 * Seeds a Customer + one paid, non-test Order for that customer.  Used
 * by Epic E session 2 integration tests to build a scorable cohort
 * without going through the webhook handlers (each handler call would
 * trigger recompute and skew the test setup).
 *
 * The order's `financialStatus = 'paid'` AND `isTest = false` makes it
 * eligible for the §S-1 cohort filter; `placedAt` controls R.
 */
async function seedScorableCustomer(args: {
  merchantId: string;
  shopifyCustomerId: string;
  shopifyOrderId: string;
  placedAt: Date;
  totalCents: bigint;
  email?: string;
}): Promise<{ customerId: string; orderId: string }> {
  return withSystemScope('test.seed_scorable', async () => {
    const client = getTestClient();
    const customer = await client.customer.create({
      data: {
        merchantId: args.merchantId,
        shopifyCustomerId: args.shopifyCustomerId,
        email: args.email ?? `seed-${args.shopifyCustomerId}@example.com`,
      },
      select: { id: true },
    });
    const order = await client.order.create({
      data: {
        merchantId: args.merchantId,
        customerId: customer.id,
        shopifyOrderId: args.shopifyOrderId,
        currency: 'USD',
        subtotalAmountCents: args.totalCents,
        totalAmountCents: args.totalCents,
        financialStatus: 'paid',
        isTest: false,
        placedAt: args.placedAt,
      },
      select: { id: true },
    });
    return { customerId: customer.id, orderId: order.id };
  });
}

describe('drainer integration (real Postgres)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await getTestClient().$disconnect();
  });

  // ---------------------------------------------------------------------
  // Real-ingest-shape happy paths — C-1 regression locks
  // ---------------------------------------------------------------------

  describe('happy path — real producer shape → drain dispatch', () => {
    it('orders/create (order.placed) → row marked processed, no error', async () => {
      const merchantId = await createTestMerchant(SHOP);
      const eventId = await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({ topic: 'orders/create', webhookId: 'wh-orders-1', shopifyOrderId: 12345 }),
      );

      const result = await runDrainTick(makeCtx());

      expect(result.claimed).toBe(1);
      const event = await assertRead(() =>
        getTestClient().outboxEvent.findUnique({ where: { id: eventId } }),
      );
      expect(event?.processedAt).not.toBeNull();
      expect(event?.deadLetteredAt).toBeNull();
      expect(event?.attempts).toBe(0);
      expect(event?.lastError).toBeNull();
    });

    it('customers/create (customer.created) → row marked processed (handleNoop)', async () => {
      const merchantId = await createTestMerchant(SHOP);
      const eventId = await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.customer.created,
        customerPayload({ webhookId: 'wh-cust-1', shopifyCustomerId: 99 }),
      );

      const result = await runDrainTick(makeCtx());

      expect(result.claimed).toBe(1);
      const event = await assertRead(() =>
        getTestClient().outboxEvent.findUnique({ where: { id: eventId } }),
      );
      expect(event?.processedAt).not.toBeNull();
      expect(event?.deadLetteredAt).toBeNull();
    });

    it('multi-event single tick → all dispatched + processed', async () => {
      const merchantId = await createTestMerchant(SHOP);
      const ids = await Promise.all([
        seedOutboxEvent(merchantId, OUTBOX_EVENTS.order.placed, orderPayload({ topic: 'orders/create', webhookId: 'wh-a', shopifyOrderId: 1 })),
        seedOutboxEvent(merchantId, OUTBOX_EVENTS.order.updated, orderPayload({ topic: 'orders/updated', webhookId: 'wh-b', shopifyOrderId: 2 })),
        seedOutboxEvent(merchantId, OUTBOX_EVENTS.customer.created, customerPayload({ webhookId: 'wh-c', shopifyCustomerId: 3 })),
      ]);

      const result = await runDrainTick(makeCtx());
      expect(result.claimed).toBe(3);

      const events = await assertRead(() =>
        getTestClient().outboxEvent.findMany({ where: { id: { in: ids } } }),
      );
      expect(events).toHaveLength(3);
      for (const event of events) {
        expect(event.processedAt).not.toBeNull();
        expect(event.deadLetteredAt).toBeNull();
      }
    });
  });

  // ---------------------------------------------------------------------
  // MARK_BEFORE_INVOKE policy
  // ---------------------------------------------------------------------

  describe('MARK_BEFORE_INVOKE policy', () => {
    it('gdpr.shop_redacted: real processor deletes Merchant + writes AuditLog', async () => {
      const merchantId = await createTestMerchant(SHOP);
      // The OutboxEvent itself will be cascade-deleted along with the
      // Merchant — that's exactly why this event is MARK_BEFORE_INVOKE.
      // Phase 1 marks processedAt inside the drainer tx (and commits)
      // BEFORE Phase 2 fires the processor that does the destructive work.
      await seedOutboxEvent(merchantId, OUTBOX_EVENTS.gdpr.shop_redacted, {
        shop_id: 1,
        shop_domain: SHOP,
      });

      await runDrainTick(makeCtx());

      // Merchant gone (cascade-delete from processShopRedact's final
      // Merchant.delete).
      const merchantCount = await assertRead(() =>
        getTestClient().merchant.count({ where: { id: merchantId } }),
      );
      expect(merchantCount).toBe(0);

      // AuditLog preserved (SetNull FK + denormalized shop). The
      // processor writes a `gdpr.shop_redact` action keyed on the
      // (now-null) merchantId; the shop column carries forensic context.
      const audit = await assertRead(() =>
        getTestClient().auditLog.findMany({
          where: { action: 'gdpr.shop_redact', shop: SHOP },
        }),
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]?.merchantId).toBeNull();
      expect(audit[0]?.actorType).toBe('system');
    });

    it('Phase 2 deferred failure: processedAt set + deferredFailedAt set, attempts NOT incremented', async () => {
      const merchantId = await createTestMerchant(SHOP);
      const eventId = await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.gdpr.shop_redacted,
        { shop_id: 1, shop_domain: SHOP },
      );

      // Custom dispatch: throws on the MARK_BEFORE_INVOKE event. Phase 1
      // marks the row processed BEFORE invoking dispatch; Phase 2 is the
      // (out-of-tx) dispatch call, where this throw lands. Drainer's
      // Phase 2 catch should write deferredFailedAt in a separate tx
      // without touching attempts.
      await runDrainTick(makeCtx(), {
        dispatch: async () => {
          throw new Error('test: Phase 2 deferred handler failed');
        },
      });

      const event = await assertRead(() =>
        getTestClient().outboxEvent.findUnique({ where: { id: eventId } }),
      );
      expect(event?.processedAt).not.toBeNull(); // Phase 1 marked
      expect(event?.deferredFailedAt).not.toBeNull(); // Phase 2 forensic marker
      expect(event?.deadLetteredAt).toBeNull(); // NOT DLQ — deferred failures are recovery-driven, not retried
      expect(event?.attempts).toBe(0); // Phase 2 does NOT increment attempts
      expect(event?.lastError).toContain('Phase 2 deferred handler failed');

      // Merchant row NOT deleted — dispatch threw before processShopRedact
      // could run. Recovery is operator-driven (manual re-invoke). Contrast
      // with test 4 above, where real dispatch succeeds and merchant.count
      // goes to 0.
    });
  });

  // ---------------------------------------------------------------------
  // DLQ logic — locks the D4 off-by-one fix and isRetryable precedence
  // ---------------------------------------------------------------------

  describe('DLQ logic', () => {
    it('non-retryable error → immediate DLQ, no retry', async () => {
      const merchantId = await createTestMerchant(SHOP);
      const eventId = await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({ topic: 'orders/create', webhookId: 'wh-nr', shopifyOrderId: 1 }),
      );

      await runDrainTick(makeCtx(), {
        // ValidationError extends AppError with retryable: false.
        // Drainer's precedence: !isRetryable wins first, before the
        // attempts-ceiling check. Should DLQ on attempt 1.
        dispatch: async () => {
          throw new ValidationError('test: non-retryable failure');
        },
      });

      const event = await assertRead(() =>
        getTestClient().outboxEvent.findUnique({ where: { id: eventId } }),
      );
      expect(event?.deadLetteredAt).not.toBeNull();
      expect(event?.processedAt).toBeNull();
      expect(event?.attempts).toBe(1); // markDeadLettered increments by 1
      expect(event?.lastError).toContain('non-retryable failure');
    });

    it('retryable error below ceiling → markFailed (attempts++), row stays claimable', async () => {
      const merchantId = await createTestMerchant(SHOP);
      const eventId = await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({ topic: 'orders/create', webhookId: 'wh-r', shopifyOrderId: 1 }),
      );

      await runDrainTick(makeCtx(), {
        // Plain Error → isRetryable returns true (default). attempts=0
        // pre-tick; (0+1) < MAX so should markFailed not DLQ.
        dispatch: async () => {
          throw new Error('test: retryable failure');
        },
      });

      const event = await assertRead(() =>
        getTestClient().outboxEvent.findUnique({ where: { id: eventId } }),
      );
      expect(event?.deadLetteredAt).toBeNull(); // Not DLQ
      expect(event?.processedAt).toBeNull(); // Not processed
      expect(event?.attempts).toBe(1); // Incremented
      expect(event?.lastError).toContain('retryable failure');
    });

    it('retryable error at attempts = MAX-1 → DLQ on this tick (locks `attempts + 1 >= MAX` off-by-one)', async () => {
      const merchantId = await createTestMerchant(SHOP);
      // Pre-set attempts to MAX-1. The drainer's ceiling check uses
      // `row.attempts + 1 >= MAX_OUTBOX_ATTEMPTS` — meaning the
      // would-be-next attempt value is what's compared. With attempts =
      // MAX-1, next = MAX, so we DLQ on this attempt. If the check were
      // off-by-one and compared `row.attempts >= MAX`, we'd markFailed
      // here and DLQ one attempt later.
      const eventId = await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({ topic: 'orders/create', webhookId: 'wh-ceiling', shopifyOrderId: 1 }),
        { attempts: MAX_OUTBOX_ATTEMPTS - 1 },
      );

      await runDrainTick(makeCtx(), {
        dispatch: async () => {
          throw new Error('test: ceiling hit');
        },
      });

      const event = await assertRead(() =>
        getTestClient().outboxEvent.findUnique({ where: { id: eventId } }),
      );
      expect(event?.deadLetteredAt).not.toBeNull(); // DLQ'd this tick
      expect(event?.attempts).toBe(MAX_OUTBOX_ATTEMPTS); // incremented to MAX
      expect(event?.lastError).toContain('ceiling hit');
    });
  });

  // ---------------------------------------------------------------------
  // Epic E session 1 — real data writers
  //
  // Tests covering the new Order + Customer upsert paths against real
  // Postgres. These exercise the full ingest → drain → upsert flow,
  // validating that the rows land with the right MAPPED fields and that
  // FK resolution / soft-delete / qualifying-transition logic behaves
  // end-to-end. The earlier "happy path" tests in this file assert
  // OutboxEvent state (processed / not DLQ'd); these assert the actual
  // data side effects.
  // ---------------------------------------------------------------------

  describe('Epic E session 1 — Order upsert (real DB)', () => {
    it('orders/create → Order row lands with mapped fields (financialStatus, totalAmountCents, currency, placedAt, shopifyProcessedAt, isTest=false)', async () => {
      const merchantId = await createTestMerchant(SHOP);
      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({
          topic: 'orders/create',
          webhookId: 'wh-e-1',
          shopifyOrderId: 10001,
          bodyOverrides: {
            processed_at: '2026-05-19T13:00:00Z', // distinct from created_at
          },
        }),
      );

      await runDrainTick(makeCtx());

      const orders = await assertRead(() =>
        getTestClient().order.findMany({ where: { merchantId } }),
      );
      expect(orders).toHaveLength(1);
      const order = orders[0]!;
      expect(order.shopifyOrderId).toBe('gid://shopify/Order/10001');
      expect(order.financialStatus).toBe('paid');
      expect(order.totalAmountCents).toBe(11000n); // 110.00 → 11000 cents
      expect(order.subtotalAmountCents).toBe(10000n);
      expect(order.totalTaxCents).toBe(1000n);
      expect(order.totalDiscountCents).toBe(0n);
      expect(order.currency).toBe('USD');
      expect(order.isTest).toBe(false);
      expect(order.placedAt.toISOString()).toBe('2026-05-19T12:00:00.000Z');
      expect(order.shopifyProcessedAt?.toISOString()).toBe('2026-05-19T13:00:00.000Z');
    });

    it('orders/updated with prior=pending + new=paid → Order.financialStatus updated to paid (qualifying-transition paid_continued)', async () => {
      const merchantId = await createTestMerchant(SHOP);
      // Pre-seed an existing order with financialStatus=pending.
      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({
          topic: 'orders/create',
          webhookId: 'wh-e-2a',
          shopifyOrderId: 20002,
          bodyOverrides: { financial_status: 'pending' },
        }),
      );
      await runDrainTick(makeCtx());

      // Now an orders/updated event flipping to paid.
      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.updated,
        orderPayload({
          topic: 'orders/updated',
          webhookId: 'wh-e-2b',
          shopifyOrderId: 20002,
          bodyOverrides: { financial_status: 'paid' },
        }),
      );
      await runDrainTick(makeCtx());

      const orders = await assertRead(() =>
        getTestClient().order.findMany({ where: { merchantId, shopifyOrderId: 'gid://shopify/Order/20002' } }),
      );
      expect(orders).toHaveLength(1); // upsert was idempotent
      expect(orders[0]?.financialStatus).toBe('paid');
    });

    it('orders/create with body.test=true → Order.isTest=true (locks the new column)', async () => {
      const merchantId = await createTestMerchant(SHOP);
      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({
          topic: 'orders/create',
          webhookId: 'wh-e-3',
          shopifyOrderId: 30003,
          bodyOverrides: { test: true },
        }),
      );
      await runDrainTick(makeCtx());

      const orders = await assertRead(() =>
        getTestClient().order.findMany({ where: { merchantId } }),
      );
      expect(orders[0]?.isTest).toBe(true);
    });

    it('orders/create with processed_at distinct from created_at → both columns distinct (locks shopifyProcessedAt)', async () => {
      const merchantId = await createTestMerchant(SHOP);
      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({
          topic: 'orders/create',
          webhookId: 'wh-e-4',
          shopifyOrderId: 40004,
          bodyOverrides: {
            created_at: '2026-01-15T08:00:00Z', // draft order created earlier
            processed_at: '2026-05-19T14:00:00Z', // converted to real order later
          },
        }),
      );
      await runDrainTick(makeCtx());

      const orders = await assertRead(() =>
        getTestClient().order.findMany({ where: { merchantId } }),
      );
      const order = orders[0]!;
      expect(order.placedAt.toISOString()).toBe('2026-01-15T08:00:00.000Z');
      expect(order.shopifyProcessedAt?.toISOString()).toBe('2026-05-19T14:00:00.000Z');
      expect(order.placedAt.getTime()).not.toBe(order.shopifyProcessedAt?.getTime());
    });

    it('orders/create idempotent replay → only one Order row after two ingests of same shopifyOrderId', async () => {
      const merchantId = await createTestMerchant(SHOP);
      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({ topic: 'orders/create', webhookId: 'wh-e-5a', shopifyOrderId: 50005 }),
      );
      await runDrainTick(makeCtx());

      // Second event same Shopify order id (Shopify retry, replay, etc.).
      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({ topic: 'orders/create', webhookId: 'wh-e-5b', shopifyOrderId: 50005 }),
      );
      await runDrainTick(makeCtx());

      const orders = await assertRead(() =>
        getTestClient().order.findMany({ where: { merchantId, shopifyOrderId: 'gid://shopify/Order/50005' } }),
      );
      expect(orders).toHaveLength(1); // composite (merchantId, shopifyOrderId) unique held
    });

    it('orders/create with line items + valid product/variant FKs → OrderLineItem rows have FKs set', async () => {
      const merchantId = await createTestMerchant(SHOP);
      const { productId, variantId } = await createTestProductWithVariant({
        merchantId,
        shopifyProductId: 'gid://shopify/Product/60001',
        shopifyVariantId: 'gid://shopify/ProductVariant/60002',
      });

      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({
          topic: 'orders/create',
          webhookId: 'wh-e-6',
          shopifyOrderId: 60010,
          bodyOverrides: {
            line_items: [
              {
                id: 60100,
                product_id: 60001,
                variant_id: 60002,
                title: 'Widget',
                quantity: 2,
                price: '10.00',
                price_set: {
                  shop_money: { amount: '10.00', currency_code: 'USD' },
                  presentment_money: { amount: '10.00', currency_code: 'USD' },
                },
              },
            ],
          },
        }),
      );
      await runDrainTick(makeCtx());

      const lineItems = await assertRead(() =>
        getTestClient().orderLineItem.findMany({ where: { merchantId } }),
      );
      expect(lineItems).toHaveLength(1);
      const li = lineItems[0]!;
      expect(li.productId).toBe(productId);
      expect(li.productVariantId).toBe(variantId);
      expect(li.quantity).toBe(2);
      expect(li.unitPriceCents).toBe(1000n);
      expect(li.currency).toBe('USD'); // sourced from parent Order
    });

    it('orders/create with line items but unknown product/variant FKs → null FKs, OrderLineItem still inserted', async () => {
      const merchantId = await createTestMerchant(SHOP);
      // NO Product / ProductVariant seeded.

      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({
          topic: 'orders/create',
          webhookId: 'wh-e-7',
          shopifyOrderId: 70010,
          bodyOverrides: {
            line_items: [
              {
                id: 70100,
                product_id: 79991, // not in DB
                variant_id: 79992, // not in DB
                title: 'Mystery item',
                quantity: 1,
                price: '5.00',
                price_set: {
                  shop_money: { amount: '5.00', currency_code: 'USD' },
                  presentment_money: { amount: '5.00', currency_code: 'USD' },
                },
              },
            ],
          },
        }),
      );
      await runDrainTick(makeCtx());

      const lineItems = await assertRead(() =>
        getTestClient().orderLineItem.findMany({ where: { merchantId } }),
      );
      expect(lineItems).toHaveLength(1);
      expect(lineItems[0]?.productId).toBeNull();
      expect(lineItems[0]?.productVariantId).toBeNull();
    });

    it('orders/create with body.customer.id matching local Customer → Order.customerId set', async () => {
      const merchantId = await createTestMerchant(SHOP);
      const localCustomerId = await createTestCustomer({
        merchantId,
        shopifyCustomerId: 'gid://shopify/Customer/80001',
      });

      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({
          topic: 'orders/create',
          webhookId: 'wh-e-11',
          shopifyOrderId: 80010,
          bodyOverrides: { customer: { id: 80001 } },
        }),
      );
      await runDrainTick(makeCtx());

      const orders = await assertRead(() =>
        getTestClient().order.findMany({ where: { merchantId } }),
      );
      expect(orders[0]?.customerId).toBe(localCustomerId);
    });

    it('orders/create with body.customer.id but unknown local customer → Order.customerId null (P-10 out-of-order delivery)', async () => {
      const merchantId = await createTestMerchant(SHOP);
      // NO local Customer seeded for shopify id 90001.

      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({
          topic: 'orders/create',
          webhookId: 'wh-e-12',
          shopifyOrderId: 90010,
          bodyOverrides: { customer: { id: 90001 } },
        }),
      );
      await runDrainTick(makeCtx());

      const orders = await assertRead(() =>
        getTestClient().order.findMany({ where: { merchantId } }),
      );
      expect(orders[0]?.customerId).toBeNull(); // null, not error
    });
  });

  describe('Epic E session 1 — Customer upsert + softDelete (real DB)', () => {
    it('customers/create → Customer row lands with mapped fields', async () => {
      const merchantId = await createTestMerchant(SHOP);
      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.customer.created,
        customerPayload({
          webhookId: 'wh-e-8',
          shopifyCustomerId: 80001,
          bodyOverrides: {
            email: 'jane@example.com',
            phone: '+15551234567',
            first_name: 'Jane',
            last_name: 'Doe',
            tags: 'vip, repeat-buyer',
            email_marketing_consent: { state: 'subscribed' },
            sms_marketing_consent: { state: 'not_subscribed' },
            orders_count: 5,
          },
        }),
      );
      await runDrainTick(makeCtx());

      const customers = await assertRead(() =>
        getTestClient().customer.findMany({ where: { merchantId } }),
      );
      expect(customers).toHaveLength(1);
      const c = customers[0]!;
      expect(c.shopifyCustomerId).toBe('gid://shopify/Customer/80001');
      expect(c.email).toBe('jane@example.com');
      expect(c.phone).toBe('+15551234567');
      expect(c.firstName).toBe('Jane');
      expect(c.lastName).toBe('Doe');
      expect(c.tags).toEqual(['vip', 'repeat-buyer']);
      expect(c.acceptsMarketing).toBe(true); // derived from consent state
      expect(c.acceptsSms).toBe(false); // default; not_subscribed doesn't override
      expect(c.ordersCount).toBe(5);
    });

    it('customers/update on existing customer → single row, email updated', async () => {
      const merchantId = await createTestMerchant(SHOP);
      // Pre-seed via customers/create event.
      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.customer.created,
        customerPayload({
          webhookId: 'wh-e-9a',
          shopifyCustomerId: 90001,
          bodyOverrides: { email: 'old@example.com' },
        }),
      );
      await runDrainTick(makeCtx());

      // Now update.
      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.customer.updated,
        customerPayload({
          topic: 'customers/update',
          webhookId: 'wh-e-9b',
          shopifyCustomerId: 90001,
          bodyOverrides: { email: 'new@example.com' },
        }),
      );
      await runDrainTick(makeCtx());

      const customers = await assertRead(() =>
        getTestClient().customer.findMany({ where: { merchantId } }),
      );
      expect(customers).toHaveLength(1);
      expect(customers[0]?.email).toBe('new@example.com');
    });

    it('customers/delete on existing customer → Customer.deletedAt set, row preserved (soft-delete)', async () => {
      const merchantId = await createTestMerchant(SHOP);
      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.customer.created,
        customerPayload({ webhookId: 'wh-e-10a', shopifyCustomerId: 100001 }),
      );
      await runDrainTick(makeCtx());

      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.customer.deleted,
        customerPayload({
          topic: 'customers/delete',
          webhookId: 'wh-e-10b',
          shopifyCustomerId: 100001,
        }),
      );
      await runDrainTick(makeCtx());

      // The Prisma soft-delete extension filters deletedAt IS NULL by
      // default on findMany; query with explicit deletedAt to see the
      // soft-deleted row.
      const customers = await assertRead(() =>
        getTestClient().customer.findMany({
          where: { merchantId, deletedAt: { not: null } },
        }),
      );
      expect(customers).toHaveLength(1);
      expect(customers[0]?.deletedAt).toBeInstanceOf(Date);
    });
  });

  // ---------------------------------------------------------------------
  // Epic E session 2 — CustomerScoreService end-to-end (real DB)
  //
  // The drainer handlers (order + customer) now invoke
  // CustomerScoreService.recompute inline.  These tests cover the six
  // end-to-end contracts from the design-doc review:
  //   1. Paid order → 4 writes in one tx (CustomerScore + Customer.state
  //      + AuditLog + OutboxEvent).
  //   2. customer.created on a fresh merchant → lurker scoring fires.
  //   3. State-band transition with a full cohort + Q6 payload shape.
  //   4. Lurker scoring inside a ≥5 cohort → null quintiles + account-age R.
  //   5. Insufficient cohort (<5) → insufficient_data state for the
  //      triggering customer.
  //   6. Guest checkout → scoring SKIPPED.
  //   7. Idempotent replay → no duplicate rows; computedAt refreshes.
  //   8. customer.deleted → no scoring; existing CustomerScore preserved.
  //
  // Helpers are direct-Prisma seeders under `withSystemScope` (the
  // `test.seed_scorable` template-literal reason).
  // ---------------------------------------------------------------------

  describe('Epic E session 2 — CustomerScoreService end-to-end (real DB)', () => {
    it('1. paid order arrival → CustomerScore + Customer.state + AuditLog + OutboxEvent all in one tx', async () => {
      const merchantId = await createTestMerchant(SHOP);
      const customerGid = 'gid://shopify/Customer/200001';
      await createTestCustomer({ merchantId, shopifyCustomerId: customerGid });

      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({
          topic: 'orders/create',
          webhookId: 'wh-s2-1',
          shopifyOrderId: 200010,
          bodyOverrides: { customer: { id: 200001 } },
        }),
      );

      await runDrainTick(makeCtx());

      // (a) CustomerScore row created.
      const scores = await assertRead(() =>
        getTestClient().customerScore.findMany({ where: { merchantId } }),
      );
      expect(scores).toHaveLength(1);
      // Single-customer cohort → insufficient → quintiles null, raw R/F/M present.
      expect(scores[0]?.rQuintile).toBeNull();
      expect(scores[0]?.fQuintile).toBeNull();
      expect(scores[0]?.mQuintile).toBeNull();
      expect(scores[0]?.churnRiskScore).toBeNull();
      expect(scores[0]?.fCount).toBe(1);
      expect(scores[0]?.mCents).toBe(11_000n); // default total_price 110.00 → 11000 cents
      expect(scores[0]?.currency).toBe('USD');

      // (b) Customer.state moved from 'active' (default) to 'insufficient_data'.
      const customer = await assertRead(() =>
        getTestClient().customer.findUnique({
          where: { merchantId_shopifyCustomerId: { merchantId, shopifyCustomerId: customerGid } },
        }),
      );
      expect(customer?.state).toBe('insufficient_data');

      // (c) AuditLog row written in the same tx.
      const audit = await assertRead(() =>
        getTestClient().auditLog.findMany({
          where: { merchantId, action: 'customer.state_changed' },
        }),
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actorType).toBe('system');
      expect(audit[0]?.actorId).toBe('drainer');
      expect(audit[0]?.targetType).toBe('customer');
      expect(audit[0]?.targetId).toBe(customer?.id);

      // (d) OutboxEvent for `customer.state_changed` emitted.
      const events = await assertRead(() =>
        getTestClient().outboxEvent.findMany({
          where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
        }),
      );
      expect(events).toHaveLength(1);
    });

    it('2. customer.created on fresh merchant → lurker scoring fires (no order required)', async () => {
      const merchantId = await createTestMerchant(SHOP);

      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.customer.created,
        customerPayload({ webhookId: 'wh-s2-2', shopifyCustomerId: 210001 }),
      );

      await runDrainTick(makeCtx());

      // CustomerScore row created for the lurker.
      const scores = await assertRead(() =>
        getTestClient().customerScore.findMany({ where: { merchantId } }),
      );
      expect(scores).toHaveLength(1);
      expect(scores[0]?.fCount).toBe(0);
      expect(scores[0]?.mCents).toBe(0n);
      expect(scores[0]?.rQuintile).toBeNull();
      expect(scores[0]?.fQuintile).toBeNull();
      expect(scores[0]?.mQuintile).toBeNull();
      expect(scores[0]?.churnRiskScore).toBeNull();

      // Cohort = 0 (no scorable customers) → insufficient_data.
      const customers = await assertRead(() =>
        getTestClient().customer.findMany({ where: { merchantId } }),
      );
      expect(customers).toHaveLength(1);
      expect(customers[0]?.state).toBe('insufficient_data');

      // OutboxEvent emitted (state changed active → insufficient_data).
      const events = await assertRead(() =>
        getTestClient().outboxEvent.findMany({
          where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
        }),
      );
      expect(events).toHaveLength(1);
    });

    it('3. state-band transition active→at_risk with full cohort + Q6 payload shape', async () => {
      const merchantId = await createTestMerchant(SHOP);
      const now = Date.now();
      // Seed 5 scorable customers spanning the quintile range.
      const seedDefs = [
        { shopify: 220001, rDaysAgo: 5, mCents: 1_000n },
        { shopify: 220002, rDaysAgo: 20, mCents: 3_000n },
        { shopify: 220003, rDaysAgo: 50, mCents: 5_000n },
        { shopify: 220004, rDaysAgo: 150, mCents: 20_000n },
        { shopify: 220005, rDaysAgo: 300, mCents: 50_000n },
      ];
      for (const def of seedDefs) {
        await seedScorableCustomer({
          merchantId,
          shopifyCustomerId: `gid://shopify/Customer/${String(def.shopify)}`,
          shopifyOrderId: `gid://shopify/Order/${String(def.shopify * 10)}`,
          placedAt: new Date(now - def.rDaysAgo * 86_400_000),
          totalCents: def.mCents,
        });
      }

      // Target customer: paid order 100d ago → R=100 → at_risk band.
      const targetGid = 'gid://shopify/Customer/220100';
      await createTestCustomer({ merchantId, shopifyCustomerId: targetGid });
      const placedAt = new Date(now - 100 * 86_400_000);

      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({
          topic: 'orders/create',
          webhookId: 'wh-s2-3',
          shopifyOrderId: 220100,
          bodyOverrides: {
            customer: { id: 220100 },
            created_at: placedAt.toISOString(),
            updated_at: placedAt.toISOString(),
            // Default total_price_set is 110.00 → mCents=11000 (lands in
            // the middle of the seeded M spread).
          },
        }),
      );

      await runDrainTick(makeCtx());

      // Find the target customer's score.
      const targetCustomer = await assertRead(() =>
        getTestClient().customer.findUnique({
          where: { merchantId_shopifyCustomerId: { merchantId, shopifyCustomerId: targetGid } },
        }),
      );
      expect(targetCustomer?.state).toBe('at_risk');

      const targetScore = await assertRead(() =>
        getTestClient().customerScore.findUnique({
          where: { customerId: targetCustomer!.id },
        }),
      );
      // Cohort = 6 → quintile math runs.  Target's quintiles MUST be populated.
      expect(targetScore?.rQuintile).not.toBeNull();
      expect(targetScore?.fQuintile).not.toBeNull();
      expect(targetScore?.mQuintile).not.toBeNull();
      expect(targetScore?.churnRiskScore).not.toBeNull();
      // R ≈ 100; some millisecond drift is fine — we only assert the band.
      expect(targetScore?.rDays).toBeGreaterThanOrEqual(99);
      expect(targetScore?.rDays).toBeLessThanOrEqual(101);
      expect(targetScore?.fCount).toBe(1);
      expect(targetScore?.mCents).toBe(11_000n);

      // Q6 OutboxEvent payload shape — locked surface for Epic G consumers.
      const events = await assertRead(() =>
        getTestClient().outboxEvent.findMany({
          where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
        }),
      );
      // 5 seeded scorable customers + target = 6 customers; we triggered
      // scoring ONLY for the target's order (the seeded ones bypassed
      // the handler).  Exactly one OutboxEvent.
      expect(events).toHaveLength(1);
      const payload = events[0]!.payload as Record<string, unknown>;
      expect(payload).toMatchObject({
        merchantId,
        customerId: targetCustomer!.id,
        shopifyCustomerId: targetGid,
        oldState: 'active',
        newState: 'at_risk',
      });
      // computedAt is an ISO 8601 UTC string.
      expect(typeof payload.computedAt).toBe('string');
      expect(payload.computedAt).toMatch(/Z$/);
      // rfmScore shape per Q6.
      const rfm = payload.rfmScore as Record<string, unknown>;
      expect(typeof rfm.rDays).toBe('number');
      expect(typeof rfm.fCount).toBe('number');
      // mCents is a DECIMAL-DIGIT STRING per rule #19 (BigInt JSON serialisation).
      expect(typeof rfm.mCents).toBe('string');
      expect(rfm.mCents).toBe('11000');
      expect(typeof rfm.rQuintile).toBe('number');
      expect(typeof rfm.fQuintile).toBe('number');
      expect(typeof rfm.mQuintile).toBe('number');
    });

    it('4. lurker scoring inside ≥5 cohort → account-age R + null quintiles', async () => {
      const merchantId = await createTestMerchant(SHOP);
      const now = Date.now();
      // Seed 5 scorable customers to make cohort ≥ threshold.
      for (let i = 0; i < 5; i++) {
        await seedScorableCustomer({
          merchantId,
          shopifyCustomerId: `gid://shopify/Customer/${String(230001 + i)}`,
          shopifyOrderId: `gid://shopify/Order/${String((230001 + i) * 10)}`,
          placedAt: new Date(now - (10 + i * 10) * 86_400_000),
          totalCents: BigInt(1000 + i * 1000),
        });
      }

      // Lurker — customer with NO paid order.  Account age = 100 days
      // → state should land in `at_risk` band (since cohort is sufficient
      // and the lurker's account-age R falls in (90, 180]).
      const lurkerGid = 'gid://shopify/Customer/230100';
      const lurkerCreatedAt = new Date(now - 100 * 86_400_000).toISOString();

      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.customer.created,
        customerPayload({
          webhookId: 'wh-s2-4',
          shopifyCustomerId: 230100,
          bodyOverrides: {
            created_at: lurkerCreatedAt,
            updated_at: lurkerCreatedAt,
          },
        }),
      );

      await runDrainTick(makeCtx());

      const lurkerCustomer = await assertRead(() =>
        getTestClient().customer.findUnique({
          where: { merchantId_shopifyCustomerId: { merchantId, shopifyCustomerId: lurkerGid } },
        }),
      );
      expect(lurkerCustomer?.state).toBe('at_risk');

      const lurkerScore = await assertRead(() =>
        getTestClient().customerScore.findUnique({
          where: { customerId: lurkerCustomer!.id },
        }),
      );
      // Lurker characteristics: null quintiles, fCount=0, mCents=0, R from account-age.
      expect(lurkerScore?.rQuintile).toBeNull();
      expect(lurkerScore?.fQuintile).toBeNull();
      expect(lurkerScore?.mQuintile).toBeNull();
      expect(lurkerScore?.churnRiskScore).toBeNull();
      expect(lurkerScore?.fCount).toBe(0);
      expect(lurkerScore?.mCents).toBe(0n);
      expect(lurkerScore?.rDays).toBeGreaterThanOrEqual(99);
      expect(lurkerScore?.rDays).toBeLessThanOrEqual(101);
    });

    it('5. insufficient cohort (4 scorable on trigger) → insufficient_data + null quintiles', async () => {
      const merchantId = await createTestMerchant(SHOP);
      const now = Date.now();
      // Seed 3 scorable customers (below the threshold of 5 on its own).
      for (let i = 0; i < 3; i++) {
        await seedScorableCustomer({
          merchantId,
          shopifyCustomerId: `gid://shopify/Customer/${String(240001 + i)}`,
          shopifyOrderId: `gid://shopify/Order/${String((240001 + i) * 10)}`,
          placedAt: new Date(now - (10 + i * 10) * 86_400_000),
          totalCents: BigInt(1000 + i * 1000),
        });
      }

      // 4th customer — pre-existing locally so the order's FK lookup resolves.
      const targetGid = 'gid://shopify/Customer/240100';
      await createTestCustomer({ merchantId, shopifyCustomerId: targetGid });

      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({
          topic: 'orders/create',
          webhookId: 'wh-s2-5',
          shopifyOrderId: 240100,
          bodyOverrides: { customer: { id: 240100 } },
        }),
      );

      await runDrainTick(makeCtx());

      // Cohort = 4 (3 seeded + the just-upserted order) < 5 → insufficient.
      const targetCustomer = await assertRead(() =>
        getTestClient().customer.findUnique({
          where: { merchantId_shopifyCustomerId: { merchantId, shopifyCustomerId: targetGid } },
        }),
      );
      expect(targetCustomer?.state).toBe('insufficient_data');

      const targetScore = await assertRead(() =>
        getTestClient().customerScore.findUnique({
          where: { customerId: targetCustomer!.id },
        }),
      );
      // Raw R/F/M present; quintiles + churn null per §S-4 insufficient path.
      expect(targetScore?.rQuintile).toBeNull();
      expect(targetScore?.fQuintile).toBeNull();
      expect(targetScore?.mQuintile).toBeNull();
      expect(targetScore?.churnRiskScore).toBeNull();
      expect(targetScore?.fCount).toBe(1);

      // State changed active → insufficient_data → exactly one OutboxEvent.
      const events = await assertRead(() =>
        getTestClient().outboxEvent.findMany({
          where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
        }),
      );
      expect(events).toHaveLength(1);
      const payload = events[0]!.payload as Record<string, unknown>;
      expect(payload).toMatchObject({
        oldState: 'active',
        newState: 'insufficient_data',
      });
    });

    it('6. guest checkout (body.customer absent) → scoring SKIPPED entirely', async () => {
      const merchantId = await createTestMerchant(SHOP);

      // Order body with NO `customer` key — guest checkout.
      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({
          topic: 'orders/create',
          webhookId: 'wh-s2-6',
          shopifyOrderId: 250010,
          // No `customer` override → key absent → schema's optional .customer.
        }),
      );

      await runDrainTick(makeCtx());

      // Order DID land — guest orders are not blocked by the scoring path.
      const orders = await assertRead(() =>
        getTestClient().order.findMany({ where: { merchantId } }),
      );
      expect(orders).toHaveLength(1);
      expect(orders[0]?.customerId).toBeNull();

      // NO CustomerScore row.
      const scores = await assertRead(() =>
        getTestClient().customerScore.findMany({ where: { merchantId } }),
      );
      expect(scores).toHaveLength(0);

      // NO customer.state_changed OutboxEvent.
      const events = await assertRead(() =>
        getTestClient().outboxEvent.findMany({
          where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
        }),
      );
      expect(events).toHaveLength(0);

      // NO customer.state_changed AuditLog.
      const audit = await assertRead(() =>
        getTestClient().auditLog.findMany({
          where: { merchantId, action: 'customer.state_changed' },
        }),
      );
      expect(audit).toHaveLength(0);
    });

    it('7. idempotent replay → single CustomerScore row, computedAt refreshes, no duplicate OutboxEvent', async () => {
      const merchantId = await createTestMerchant(SHOP);
      const customerGid = 'gid://shopify/Customer/260001';
      await createTestCustomer({ merchantId, shopifyCustomerId: customerGid });

      // First arrival of the order.
      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({
          topic: 'orders/create',
          webhookId: 'wh-s2-7a',
          shopifyOrderId: 260010,
          bodyOverrides: { customer: { id: 260001 } },
        }),
      );
      await runDrainTick(makeCtx());

      const firstScore = await assertRead(() =>
        getTestClient().customerScore.findMany({ where: { merchantId } }),
      );
      expect(firstScore).toHaveLength(1);
      const firstComputedAt = firstScore[0]!.computedAt;

      // Tiny delay so the second recompute's `now = new Date()` is strictly
      // greater than the first — required for the computedAt-refresh assertion.
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Second arrival with same order id but different webhook id —
      // production replay path (Shopify retries with the same X-Shopify-
      // Webhook-Id; here we simulate two distinct deliveries of the same
      // logical event).
      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({
          topic: 'orders/create',
          webhookId: 'wh-s2-7b',
          shopifyOrderId: 260010,
          bodyOverrides: { customer: { id: 260001 } },
        }),
      );
      await runDrainTick(makeCtx());

      // Still exactly one Order, one CustomerScore.
      const orders = await assertRead(() =>
        getTestClient().order.findMany({ where: { merchantId } }),
      );
      expect(orders).toHaveLength(1);
      const scoresAfter = await assertRead(() =>
        getTestClient().customerScore.findMany({ where: { merchantId } }),
      );
      expect(scoresAfter).toHaveLength(1);
      // computedAt MUST be ≥ first run's value (refreshed in place).
      expect(scoresAfter[0]!.computedAt.getTime()).toBeGreaterThan(firstComputedAt.getTime());

      // State didn't change on the second run (already insufficient_data) →
      // exactly ONE state-changed OutboxEvent total, from the first run.
      const events = await assertRead(() =>
        getTestClient().outboxEvent.findMany({
          where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
        }),
      );
      expect(events).toHaveLength(1);

      // Same for the AuditLog (state-changed action is only logged on
      // actual transitions).
      const audit = await assertRead(() =>
        getTestClient().auditLog.findMany({
          where: { merchantId, action: 'customer.state_changed' },
        }),
      );
      expect(audit).toHaveLength(1);
    });

    it('8. customer.deleted → NO scoring fires; existing CustomerScore preserved (§S-7 forensic)', async () => {
      const merchantId = await createTestMerchant(SHOP);
      const customerGid = 'gid://shopify/Customer/270001';
      await createTestCustomer({ merchantId, shopifyCustomerId: customerGid });

      // Step 1: paid order arrives → scoring writes a CustomerScore row.
      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({
          topic: 'orders/create',
          webhookId: 'wh-s2-8a',
          shopifyOrderId: 270010,
          bodyOverrides: { customer: { id: 270001 } },
        }),
      );
      await runDrainTick(makeCtx());

      const scoresBefore = await assertRead(() =>
        getTestClient().customerScore.findMany({ where: { merchantId } }),
      );
      expect(scoresBefore).toHaveLength(1);
      const scoreIdBefore = scoresBefore[0]!.id;
      const stateBefore = (await assertRead(() =>
        getTestClient().customer.findUnique({
          where: { merchantId_shopifyCustomerId: { merchantId, shopifyCustomerId: customerGid } },
        }),
      ))?.state;
      expect(stateBefore).toBe('insufficient_data');

      const eventsBefore = await assertRead(() =>
        getTestClient().outboxEvent.findMany({
          where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
        }),
      );
      expect(eventsBefore).toHaveLength(1);
      const auditBefore = await assertRead(() =>
        getTestClient().auditLog.findMany({
          where: { merchantId, action: 'customer.state_changed' },
        }),
      );
      expect(auditBefore).toHaveLength(1);

      // Step 2: customers/delete arrives → soft delete; scoring MUST be
      // skipped per §S-7.
      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.customer.deleted,
        customerPayload({
          topic: 'customers/delete',
          webhookId: 'wh-s2-8b',
          shopifyCustomerId: 270001,
        }),
      );
      await runDrainTick(makeCtx());

      // CustomerScore row STILL exists (forensic).
      const scoresAfter = await assertRead(() =>
        getTestClient().customerScore.findMany({ where: { merchantId } }),
      );
      expect(scoresAfter).toHaveLength(1);
      expect(scoresAfter[0]!.id).toBe(scoreIdBefore);

      // Customer is soft-deleted.
      const deletedCustomer = await assertRead(() =>
        getTestClient().customer.findFirst({
          where: { merchantId, shopifyCustomerId: customerGid, deletedAt: { not: null } },
        }),
      );
      expect(deletedCustomer?.deletedAt).toBeInstanceOf(Date);
      // State unchanged from pre-delete.
      expect(deletedCustomer?.state).toBe('insufficient_data');

      // NO new state-changed OutboxEvent + NO new AuditLog row from the
      // deletion path — the existing single rows from step 1 remain.
      const eventsAfter = await assertRead(() =>
        getTestClient().outboxEvent.findMany({
          where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
        }),
      );
      expect(eventsAfter).toHaveLength(1);
      const auditAfter = await assertRead(() =>
        getTestClient().auditLog.findMany({
          where: { merchantId, action: 'customer.state_changed' },
        }),
      );
      expect(auditAfter).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------
  // A1a — first-pass state-transition suppression (real DB)
  //
  // Lock V10 / POST-EPIC-F §1 + lock #22/C9. While
  // Merchant.scoringInitializedAt is null, recompute writes CustomerScore +
  // Customer.state but SUPPRESSES the customer.state_changed AuditLog +
  // OutboxEvent — no winback storm on install day (zero state_changed events
  // ⇒ zero downstream AiGenerations). Once the flag is set (bulk-rescore A1b,
  // or steady state) transitions emit normally.
  //
  // createTestMerchant defaults to INITIALIZED; the suppression case passes
  // `{ scoringInitializedAt: null }` explicitly.
  // ---------------------------------------------------------------------

  describe('A1a — first-pass state-transition suppression (real DB)', () => {
    it('un-initialized merchant (scoringInitializedAt null) → score + state written, ZERO state_changed OutboxEvent + AuditLog', async () => {
      const merchantId = await createTestMerchant(SHOP, { scoringInitializedAt: null });
      const customerGid = 'gid://shopify/Customer/300001';
      await createTestCustomer({ merchantId, shopifyCustomerId: customerGid });

      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({
          topic: 'orders/create',
          webhookId: 'wh-a1a-1',
          shopifyOrderId: 300010,
          bodyOverrides: { customer: { id: 300001 } },
        }),
      );

      await runDrainTick(makeCtx());

      // (a) DATA IS written — the band must be correct (active → insufficient_data).
      const scores = await assertRead(() =>
        getTestClient().customerScore.findMany({ where: { merchantId } }),
      );
      expect(scores).toHaveLength(1);
      const customer = await assertRead(() =>
        getTestClient().customer.findUnique({
          where: { merchantId_shopifyCustomerId: { merchantId, shopifyCustomerId: customerGid } },
        }),
      );
      expect(customer?.state).toBe('insufficient_data'); // changed from default 'active'

      // (b) SUPPRESSED — no winback send-driver event, no forensic transition row.
      const events = await assertRead(() =>
        getTestClient().outboxEvent.findMany({
          where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
        }),
      );
      expect(events).toHaveLength(0);
      const audit = await assertRead(() =>
        getTestClient().auditLog.findMany({
          where: { merchantId, action: 'customer.state_changed' },
        }),
      );
      expect(audit).toHaveLength(0);
    });

    it('initialized merchant (scoringInitializedAt set) → exactly one state_changed OutboxEvent + AuditLog (emit-when-set)', async () => {
      const merchantId = await createTestMerchant(SHOP); // default = initialized
      const customerGid = 'gid://shopify/Customer/310001';
      await createTestCustomer({ merchantId, shopifyCustomerId: customerGid });

      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({
          topic: 'orders/create',
          webhookId: 'wh-a1a-2',
          shopifyOrderId: 310010,
          bodyOverrides: { customer: { id: 310001 } },
        }),
      );

      await runDrainTick(makeCtx());

      const events = await assertRead(() =>
        getTestClient().outboxEvent.findMany({
          where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
        }),
      );
      expect(events).toHaveLength(1);
      const audit = await assertRead(() =>
        getTestClient().auditLog.findMany({
          where: { merchantId, action: 'customer.state_changed' },
        }),
      );
      expect(audit).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------
  // A1b — bulkRescore first-pass engine (real DB)
  //
  // The operator first-pass: scores a merchant's whole base WITHOUT emitting
  // customer.state_changed (Design B — bulkRescore never emits), then sets
  // scoringInitializedAt. The end-to-end "scores the base, no storm, then
  // steady-state emits" proof. --force re-baseline is still emission-free.
  // ---------------------------------------------------------------------

  describe('A1b — bulkRescore first-pass (real DB)', () => {
    function makeService(): CustomerScoreService {
      const client = getTestClient();
      return new CustomerScoreService(
        new CustomerScoreRepository(client),
        new AuditLogRepository(client),
      );
    }

    it('scores a mixed base with ZERO state_changed events, sets flag, ONE merchant.scoring_initialized audit; then steady-state emits', async () => {
      const merchantId = await createTestMerchant(SHOP, { scoringInitializedAt: null });
      const now = new Date();

      // 5 scorable customers (cohort ≥ threshold → quintiles compute) + 1 lurker.
      for (let i = 0; i < 5; i++) {
        await seedScorableCustomer({
          merchantId,
          shopifyCustomerId: `gid://shopify/Customer/${String(400001 + i)}`,
          shopifyOrderId: `gid://shopify/Order/${String((400001 + i) * 10)}`,
          placedAt: new Date(now.getTime() - (10 + i * 40) * 86_400_000),
          totalCents: BigInt(1000 * (i + 1)),
        });
      }
      await createTestCustomer({ merchantId, shopifyCustomerId: 'gid://shopify/Customer/400100' });

      // Run the first pass.
      const summary = await withTenantScope(merchantId, async () =>
        makeService().bulkRescore(getTestClient(), { merchantId, now, actorId: 'test-operator' }),
      );

      // Every customer scored (5 scorable + 1 lurker).
      const scores = await assertRead(() =>
        getTestClient().customerScore.findMany({ where: { merchantId } }),
      );
      expect(scores).toHaveLength(6);
      expect(summary.customersScored).toBe(6);

      // ZERO state_changed OutboxEvents + ZERO state_changed AuditLogs (no storm).
      const events = await assertRead(() =>
        getTestClient().outboxEvent.findMany({
          where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
        }),
      );
      expect(events).toHaveLength(0);
      const stateAudits = await assertRead(() =>
        getTestClient().auditLog.findMany({
          where: { merchantId, action: 'customer.state_changed' },
        }),
      );
      expect(stateAudits).toHaveLength(0);

      // EXACTLY ONE merchant.scoring_initialized audit.
      const initAudits = await assertRead(() =>
        getTestClient().auditLog.findMany({
          where: { merchantId, action: 'merchant.scoring_initialized' },
        }),
      );
      expect(initAudits).toHaveLength(1);
      expect(initAudits[0]?.targetType).toBe('merchant');
      expect(initAudits[0]?.actorId).toBe('test-operator');

      // Flag now set — the gate is open.
      const merchant = await assertRead(() =>
        getTestClient().merchant.findUnique({ where: { id: merchantId } }),
      );
      expect(merchant?.scoringInitializedAt).toBeInstanceOf(Date);

      // STEADY-STATE PROOF: post-flag, a NEW customer's order transition emits
      // exactly one event (gate open).
      await createTestCustomer({ merchantId, shopifyCustomerId: 'gid://shopify/Customer/400200' });
      await seedOutboxEvent(
        merchantId,
        OUTBOX_EVENTS.order.placed,
        orderPayload({
          topic: 'orders/create',
          webhookId: 'wh-a1b-steady',
          shopifyOrderId: 400200,
          bodyOverrides: {
            customer: { id: 400200 },
            created_at: new Date(now.getTime() - 200 * 86_400_000).toISOString(),
          },
        }),
      );
      await runDrainTick(makeCtx());

      const eventsAfter = await assertRead(() =>
        getTestClient().outboxEvent.findMany({
          where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
        }),
      );
      expect(eventsAfter).toHaveLength(1);
    });

    it('--force re-baseline on an initialized merchant still emits ZERO events (Design B)', async () => {
      const merchantId = await createTestMerchant(SHOP, { scoringInitializedAt: null });
      const now = new Date();
      for (let i = 0; i < 5; i++) {
        await seedScorableCustomer({
          merchantId,
          shopifyCustomerId: `gid://shopify/Customer/${String(410001 + i)}`,
          shopifyOrderId: `gid://shopify/Order/${String((410001 + i) * 10)}`,
          placedAt: new Date(now.getTime() - (10 + i * 40) * 86_400_000),
          totalCents: BigInt(1000 * (i + 1)),
        });
      }

      // First pass, then a re-baseline (the CLI gates this behind --force; the
      // service ALWAYS suppresses regardless).
      await withTenantScope(merchantId, async () =>
        makeService().bulkRescore(getTestClient(), { merchantId, now, actorId: 'op' }),
      );
      await withTenantScope(merchantId, async () =>
        makeService().bulkRescore(getTestClient(), { merchantId, now: new Date(), actorId: 'op' }),
      );

      // Re-run NEVER emits.
      const events = await assertRead(() =>
        getTestClient().outboxEvent.findMany({
          where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
        }),
      );
      expect(events).toHaveLength(0);

      // One scoring-initialized audit per pass (forensic record of each run).
      const initAudits = await assertRead(() =>
        getTestClient().auditLog.findMany({
          where: { merchantId, action: 'merchant.scoring_initialized' },
        }),
      );
      expect(initAudits).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------
  // decay-rescore sweep (real DB)
  //
  // The steady-state calendar-driven transition detector. Re-evaluates
  // the working set (active/warm/at_risk/dormant), emits
  // customer.state_changed for real decay transitions (gated on
  // scoringInitializedAt), skips terminal `lost` + cohort-driven
  // `insufficient_data`. `now` is injected so transitions are
  // deterministic without clock-pinning.
  // ---------------------------------------------------------------------

  describe('decay-rescore sweep (real DB)', () => {
    function makeService(): CustomerScoreService {
      const client = getTestClient();
      return new CustomerScoreService(
        new CustomerScoreRepository(client),
        new AuditLogRepository(client),
      );
    }

    async function setCustomerState(customerId: string, state: string): Promise<void> {
      await withSystemScope('test.set_state', async () => {
        await getTestClient().customer.update({
          where: { id: customerId },
          // Cast — the test deliberately presets the band to the "before"
          // value; production only writes it through CustomerScoreService.
          data: { state: state as never },
        });
      });
    }

    it('initialized merchant: emits exactly for customers whose band crossed; skips lost; respects no-change', async () => {
      const merchantId = await createTestMerchant(SHOP); // initialized (default)
      const now = new Date('2026-06-10T00:00:00.000Z');
      const daysAgo = (n: number): Date => new Date(now.getTime() - n * 86_400_000);

      // 5 scorable customers (all orders within 365d → cohort sufficient).
      const a = await seedScorableCustomer({
        merchantId,
        shopifyCustomerId: 'gid://shopify/Customer/700001',
        shopifyOrderId: 'gid://shopify/Order/7000010',
        placedAt: daysAgo(95), // → at_risk
        totalCents: 5_000n,
      });
      const b = await seedScorableCustomer({
        merchantId,
        shopifyCustomerId: 'gid://shopify/Customer/700002',
        shopifyOrderId: 'gid://shopify/Order/7000020',
        placedAt: daysAgo(50), // → warm
        totalCents: 4_000n,
      });
      const c = await seedScorableCustomer({
        merchantId,
        shopifyCustomerId: 'gid://shopify/Customer/700003',
        shopifyOrderId: 'gid://shopify/Order/7000030',
        placedAt: daysAgo(20), // → active
        totalCents: 3_000n,
      });
      const d = await seedScorableCustomer({
        merchantId,
        shopifyCustomerId: 'gid://shopify/Customer/700004',
        shopifyOrderId: 'gid://shopify/Order/7000040',
        placedAt: daysAgo(200), // → dormant
        totalCents: 2_000n,
      });
      const e = await seedScorableCustomer({
        merchantId,
        shopifyCustomerId: 'gid://shopify/Customer/700005',
        shopifyOrderId: 'gid://shopify/Order/7000050',
        placedAt: daysAgo(120), // → at_risk
        totalCents: 1_000n,
      });
      // A lost lurker (no order) — must be SKIPPED by the working-set filter.
      const fId = await createTestCustomer({
        merchantId,
        shopifyCustomerId: 'gid://shopify/Customer/700006',
      });

      // Preset the "before" bands.
      await setCustomerState(a.customerId, 'warm'); // → crosses to at_risk
      await setCustomerState(b.customerId, 'warm'); // → stays warm
      await setCustomerState(c.customerId, 'active'); // → stays active
      await setCustomerState(d.customerId, 'at_risk'); // → crosses to dormant
      await setCustomerState(e.customerId, 'at_risk'); // → stays at_risk
      await setCustomerState(fId, 'lost'); // → SKIPPED (terminal)

      const result = await withTenantScope(merchantId, async () =>
        makeService().decayRescore(getTestClient(), { merchantId, now, actorId: 'scheduler' }),
      );

      // 5 in the working set evaluated (F=lost excluded); 2 crossed (A, D).
      expect(result.customersEvaluated).toBe(5);
      expect(result.transitions).toBe(2);
      expect(result.emitted).toBe(2);

      // A: warm → at_risk; D: at_risk → dormant.
      const aRow = await assertRead(() =>
        getTestClient().customer.findUnique({ where: { id: a.customerId } }),
      );
      expect(aRow?.state).toBe('at_risk');
      const dRow = await assertRead(() =>
        getTestClient().customer.findUnique({ where: { id: d.customerId } }),
      );
      expect(dRow?.state).toBe('dormant');

      // F stays lost — never touched.
      const fRow = await assertRead(() =>
        getTestClient().customer.findUnique({ where: { id: fId } }),
      );
      expect(fRow?.state).toBe('lost');

      // Exactly 2 customer.state_changed OutboxEvents + 2 AuditLogs.
      const events = await assertRead(() =>
        getTestClient().outboxEvent.findMany({
          where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
        }),
      );
      expect(events).toHaveLength(2);
      const audits = await assertRead(() =>
        getTestClient().auditLog.findMany({
          where: { merchantId, action: 'customer.state_changed' },
        }),
      );
      expect(audits).toHaveLength(2);
      // The decay discriminator is on the audit context.
      expect(audits.every((a2) => (a2.context as { trigger?: string }).trigger === 'decay_sweep')).toBe(true);
    });

    it('NOT-yet-initialized merchant: band updates but ZERO emit (§1 gate)', async () => {
      const merchantId = await createTestMerchant(SHOP, { scoringInitializedAt: null });
      const now = new Date('2026-06-10T00:00:00.000Z');
      const daysAgo = (n: number): Date => new Date(now.getTime() - n * 86_400_000);

      // 5 scorable for a sufficient cohort; one preset to a stale band.
      const targets = [];
      for (let i = 0; i < 5; i++) {
        targets.push(
          await seedScorableCustomer({
            merchantId,
            shopifyCustomerId: `gid://shopify/Customer/${String(710001 + i)}`,
            shopifyOrderId: `gid://shopify/Order/${String((710001 + i) * 10)}`,
            placedAt: daysAgo(95 + i * 30), // 95,125,155,185,215 → various decayed bands
            totalCents: BigInt(1000 * (i + 1)),
          }),
        );
      }
      // Preset all to 'warm' so each crosses to a more-decayed band.
      for (const t of targets) {
        await setCustomerState(t.customerId, 'warm');
      }

      const result = await withTenantScope(merchantId, async () =>
        makeService().decayRescore(getTestClient(), { merchantId, now, actorId: 'scheduler' }),
      );

      // Bands updated (data write unconditional)...
      expect(result.transitions).toBeGreaterThan(0);
      // ...but emission fully suppressed (gate closed).
      expect(result.emitted).toBe(0);
      const events = await assertRead(() =>
        getTestClient().outboxEvent.findMany({
          where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
        }),
      );
      expect(events).toHaveLength(0);
      const audits = await assertRead(() =>
        getTestClient().auditLog.findMany({
          where: { merchantId, action: 'customer.state_changed' },
        }),
      );
      expect(audits).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // order backfill → then score (real DB)
  //
  // The end-to-end "backfill then score" proof + the silent-no-recompute
  // property. Drives the real BackfillRunner + OrderPageProcessor (which
  // adapts GraphQL nodes → upsertFromWebhook) against the real DB with a
  // MOCK fetcher (no Shopify API), then runs bulkRescore to confirm the
  // now-populated cohort scores correctly.
  // ---------------------------------------------------------------------

  describe('order backfill → then score (real DB)', () => {
    function moneyBag(amount: string) {
      return {
        shopMoney: { amount, currencyCode: 'USD' },
        presentmentMoney: { amount, currencyCode: 'USD' },
      };
    }

    function orderNode(args: {
      orderId: number;
      customerGid: string;
      placedAt: Date;
      totalAmount: string;
    }): ShopifyOrderNode {
      return {
        id: `gid://shopify/Order/${String(args.orderId)}`,
        name: `#${String(args.orderId)}`,
        test: false,
        displayFinancialStatus: 'PAID',
        displayFulfillmentStatus: 'FULFILLED',
        currencyCode: 'USD',
        presentmentCurrencyCode: 'USD',
        createdAt: args.placedAt.toISOString(),
        updatedAt: args.placedAt.toISOString(),
        processedAt: args.placedAt.toISOString(),
        cancelledAt: null,
        subtotalPriceSet: moneyBag(args.totalAmount),
        totalPriceSet: moneyBag(args.totalAmount),
        totalTaxSet: moneyBag('0.00'),
        totalDiscountsSet: moneyBag('0.00'),
        customer: { id: args.customerGid },
        lineItems: { nodes: [] },
      };
    }

    /** Single-page mock fetcher returning the given nodes. */
    function mockFetcher(nodes: readonly ShopifyOrderNode[]): PageFetcher<ShopifyOrderNode> {
      return {
        fetch: async (): Promise<ResourcePage<ShopifyOrderNode>> => ({
          items: nodes,
          endCursor: null,
          hasNextPage: false,
        }),
      };
    }

    function makeService(): CustomerScoreService {
      const client = getTestClient();
      return new CustomerScoreService(
        new CustomerScoreRepository(client),
        new AuditLogRepository(client),
      );
    }

    it('backfills orders SILENTLY (no CustomerScore, no events), then bulkRescore reads the populated cohort', async () => {
      const merchantId = await createTestMerchant(SHOP, { scoringInitializedAt: null });
      const now = new Date('2026-06-10T00:00:00.000Z');
      const daysAgo = (n: number): Date => new Date(now.getTime() - n * 86_400_000);

      // 5 customers (GIDs match the order nodes' customer.id) — no orders yet.
      const nodes: ShopifyOrderNode[] = [];
      for (let i = 0; i < 5; i++) {
        const customerGid = `gid://shopify/Customer/${String(900001 + i)}`;
        await createTestCustomer({ merchantId, shopifyCustomerId: customerGid });
        nodes.push(
          orderNode({
            orderId: 800001 + i,
            customerGid,
            placedAt: daysAgo(10 + i * 20), // 10,30,50,70,90 days → varied recency
            totalAmount: `${String(100 + i * 10)}.00`,
          }),
        );
      }

      // Run the REAL backfill (real runner + processor + adapter +
      // upsertFromWebhook) with the mock fetcher.
      const runner = new BackfillRunner<ShopifyOrderNode>(
        getTestClient(),
        mockFetcher(nodes),
        new OrderPageProcessor(),
      );
      const result = await runner.run({ merchantId, resource: ORDER_BACKFILL_RESOURCE });
      expect(result.finalStatus).toBe('completed');
      expect(result.itemsProcessed).toBe(5);

      // (a) 5 Order rows landed, paid, non-test, customer FK resolved,
      //     money in cents (100.00 → 10000).
      const orders = await assertRead(() =>
        getTestClient().order.findMany({ where: { merchantId }, orderBy: { placedAt: 'asc' } }),
      );
      expect(orders).toHaveLength(5);
      expect(orders.every((o) => o.financialStatus === 'paid')).toBe(true);
      expect(orders.every((o) => !o.isTest)).toBe(true);
      expect(orders.every((o) => o.customerId !== null)).toBe(true);
      // Money: each "1NN.00" decimal → NN000 cents. Assert the full set
      // (index-independent — orders are placedAt-asc, not seed order).
      const centsSorted = orders
        .map((o) => o.totalAmountCents)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      expect(centsSorted).toEqual([10000n, 11000n, 12000n, 13000n, 14000n]);

      // (b) SILENT — the backfill did NOT score. No CustomerScore rows, no
      //     customer.state_changed events (recompute lives in the handler,
      //     not the repo the processor calls).
      const scoresBefore = await assertRead(() =>
        getTestClient().customerScore.findMany({ where: { merchantId } }),
      );
      expect(scoresBefore).toHaveLength(0);
      const eventsBefore = await assertRead(() =>
        getTestClient().outboxEvent.findMany({
          where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
        }),
      );
      expect(eventsBefore).toHaveLength(0);

      // (c) NOW score — bulkRescore reads the populated cohort. With 5
      //     paid-in-365d customers the cohort is sufficient → they resolve
      //     as SCORABLE (real quintiles), NOT account-age lurkers.
      const summary = await withTenantScope(merchantId, async () =>
        makeService().bulkRescore(getTestClient(), { merchantId, now, actorId: 'test-op' }),
      );
      expect(summary.cohortSize).toBe(5); // the backfilled orders populate the cohort
      expect(summary.customersScored).toBe(5);

      const scoresAfter = await assertRead(() =>
        getTestClient().customerScore.findMany({ where: { merchantId } }),
      );
      expect(scoresAfter).toHaveLength(5);
      // Scorable (cohort ≥ threshold) → real quintiles, NOT null/insufficient.
      expect(scoresAfter.every((s) => s.rQuintile !== null)).toBe(true);
    });
  });
});
