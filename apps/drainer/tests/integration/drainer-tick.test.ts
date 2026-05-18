import {
  MAX_OUTBOX_ATTEMPTS,
  OUTBOX_EVENTS,
  type OutboxEventType,
} from '@winback/contracts';
import {
  type OutboxEventRow,
  withSystemScope,
  type WinbackPrisma,
} from '@winback/db';
import {
  assertRead,
  createTestMerchant,
  getTestClient,
  resetDb,
} from '@winback/db/test-utils';
import { ValidationError } from '@winback/errors';
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

/**
 * Producer-shaped payload for an order event. Matches webhook-ingest.
 */
function orderPayload(args: {
  topic: 'orders/create' | 'orders/updated';
  webhookId: string;
  shopifyOrderId: number | string;
}): Record<string, unknown> {
  return {
    topic: args.topic,
    webhookId: args.webhookId,
    body: { id: args.shopifyOrderId, financial_status: 'paid' },
  };
}

/**
 * Producer-shaped payload for a customers/create event.
 */
function customerPayload(args: {
  webhookId: string;
  shopifyCustomerId: number | string;
}): Record<string, unknown> {
  return {
    topic: 'customers/create',
    webhookId: args.webhookId,
    body: { id: args.shopifyCustomerId, email: 'test@example.com' },
  };
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
});
