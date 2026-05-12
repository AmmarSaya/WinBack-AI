/**
 * M3-Smoke integration suite.
 *
 * Five assertions covering the highest-risk patterns from B2/B3, plus
 * one paired with the `completeInstall` idempotency fix:
 *
 *   1. UnitOfWork.run commits Customer + OutboxEvent atomically.
 *   2. UnitOfWork.run rolls both back when the callback throws.
 *   3. Tenant-scope assertion fires on writes inside a $transaction.
 *   4. T1 functional + partial index is used for case-insensitive
 *      email lookup (EXPLAIN check).
 *   5. T4 / T5 CHECK constraints reject malformed input at the DB layer.
 *   6. `completeInstall` heals a partial-failure reinstall (proves the
 *      idempotency fix bundled in this milestone).
 *
 * Cap is six. If a seventh feels needed, it belongs in the M10 full
 * integration harness, not here.
 */

import { Prisma } from '@prisma/client';
import { completeInstall } from '@winback/shopify';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  OUTBOX_EVENTS,
  TenantScopeError,
  UnitOfWork,
  withSystemScope,
  withTenantScope,
} from '../../src/index.js';
import { createTestMerchant, getTestClient, resetDb } from './setup.js';

const SHOP = 'smoke.myshopify.com';
const REINSTALL_SHOP = 'reinstall.myshopify.com';

const prisma = getTestClient();
let merchantId: string;

beforeAll(async () => {
  await resetDb();
  merchantId = await createTestMerchant(SHOP);
});

beforeEach(async () => {
  // Clear per-test state under the primary merchant. Other merchants
  // (e.g. the completeInstall test's shop) reset themselves.
  await withSystemScope('test.cleanup_per_test', async () => {
    await prisma.outboxEvent.deleteMany({ where: { merchantId } });
    await prisma.customer.deleteMany({ where: { merchantId } });
  });
});

describe('M3-Smoke', () => {
  it('1. UnitOfWork.run commits Customer + OutboxEvent atomically', async () => {
    const uow = new UnitOfWork(prisma);

    await withTenantScope(merchantId, async () => {
      await uow.run(async (ctx) => {
        await ctx.db.customer.create({
          data: { merchantId, shopifyCustomerId: 'smoke-1' },
        });
        await ctx.publish(OUTBOX_EVENTS.customer.created, { id: 'smoke-1' });
      });
    });

    const [customers, events] = await withSystemScope('test.assert', () =>
      Promise.all([
        prisma.customer.findMany({ where: { merchantId } }),
        prisma.outboxEvent.findMany({ where: { merchantId } }),
      ]),
    );
    expect(customers).toHaveLength(1);
    expect(customers[0]?.shopifyCustomerId).toBe('smoke-1');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(OUTBOX_EVENTS.customer.created);
  });

  it('2. UnitOfWork.run rolls back BOTH rows when callback throws', async () => {
    const uow = new UnitOfWork(prisma);

    await expect(
      withTenantScope(merchantId, () =>
        uow.run(async (ctx) => {
          await ctx.db.customer.create({
            data: { merchantId, shopifyCustomerId: 'smoke-2' },
          });
          await ctx.publish(OUTBOX_EVENTS.customer.created, { id: 'smoke-2' });
          throw new Error('intentional rollback');
        }),
      ),
    ).rejects.toThrow('intentional rollback');

    const [customers, events] = await withSystemScope('test.assert', () =>
      Promise.all([
        prisma.customer.findMany({ where: { merchantId } }),
        prisma.outboxEvent.findMany({ where: { merchantId } }),
      ]),
    );
    expect(customers).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('3. Tenant assertion fires on writes inside a $transaction', async () => {
    // Inside withTenantScope(merchantId), attempt to write data targeting
    // a DIFFERENT merchantId. The extension must reject.
    await expect(
      withTenantScope(merchantId, () =>
        prisma.$transaction(async (tx) => {
          await tx.customer.create({
            data: {
              merchantId: 'INTENTIONALLY_WRONG_MERCHANT',
              shopifyCustomerId: 'smoke-3',
            },
          });
        }),
      ),
    ).rejects.toThrow(TenantScopeError);
  });

  it('4. T1 functional + partial index is used for case-insensitive email lookup', async () => {
    await withTenantScope(merchantId, async () => {
      await prisma.customer.create({
        data: {
          merchantId,
          shopifyCustomerId: 'smoke-4',
          email: 'Test.User@Example.COM',
        },
      });
    });

    // EXPLAIN the exact query shape that CustomerRepository.findByEmail
    // issues. Verify the partial-functional index is chosen.
    const plan = await withSystemScope('test.assert_plan', () =>
      prisma.$queryRaw<{ 'QUERY PLAN': string }[]>`
        EXPLAIN SELECT *
        FROM "Customer"
        WHERE "merchantId" = ${merchantId}
          AND lower(email) = lower(${'test.user@example.com'})
          AND "deletedAt" IS NULL
        LIMIT 1
      `,
    );
    const planText = plan.map((row) => row['QUERY PLAN']).join('\n');
    expect(planText).toMatch(/customer_merchant_email_lower/i);
  });

  it('5. T4 / T5 CHECK constraints reject malformed input', async () => {
    // T4: OutboxEvent.type format. Extension doesn't validate `type` value
    // (only model-specific checks for aiTone) so the raw value reaches
    // the DB CHECK.
    await expect(
      withTenantScope(merchantId, () =>
        prisma.outboxEvent.create({
          data: { merchantId, type: 'INVALID UPPERCASE WITH SPACES', payload: {} },
        }),
      ),
    ).rejects.toThrow(/outbox_event_type_format/);

    // T5: MerchantSettings.aiTone structural floor. The extension's zod
    // validator would reject this BEFORE the DB. To exercise the DB CHECK
    // directly we bypass the extension via $executeRawUnsafe (raw
    // operations don't run query extensions per Prisma 5 docs).
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "MerchantSettings" SET "aiTone" = '"a string"'::jsonb WHERE "merchantId" = $1`,
        merchantId,
      ),
    ).rejects.toThrow(/merchant_settings_ai_tone_shape/);
  });

  it('6. completeInstall heals partial-failure reinstall state', async () => {
    // First install: clean creation.
    const first = await completeInstall(prisma, {
      shop: REINSTALL_SHOP,
      accessToken: 'token-v1',
      scope: 'read_customers',
    });
    expect(first.isNewInstall).toBe(true);

    // Simulate a partial-failure prior state: delete MerchantSettings
    // (could happen via a botched data migration, hand edit, or a prior
    // install that crashed between Merchant.create and Settings.create
    // BEFORE the idempotency fix landed).
    await withSystemScope('test.simulate_corruption', async () => {
      await prisma.merchantSettings.delete({
        where: { merchantId: first.merchantId },
      });
    });

    // Reinstall: must succeed AND restore the missing settings row.
    const second = await completeInstall(prisma, {
      shop: REINSTALL_SHOP,
      accessToken: 'token-v2',
      scope: 'read_customers',
    });
    expect(second.isNewInstall).toBe(false);
    expect(second.merchantId).toBe(first.merchantId);

    const healed = await withSystemScope('test.assert_healed', () =>
      prisma.merchantSettings.findUnique({
        where: { merchantId: first.merchantId },
      }),
    );
    expect(healed).not.toBeNull();
    // Defaults are preserved on heal (not overwritten).
    expect(healed?.monthlySendsCap).toBe(1000);
    expect(healed?.attributionDirectWindowDays).toBe(14);

    // And the outbox got the reinstall event.
    const events = await withSystemScope('test.assert_events', () =>
      prisma.outboxEvent.findMany({
        where: { merchantId: first.merchantId, type: OUTBOX_EVENTS.merchant.installed },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(events).toHaveLength(2);
    expect((events[1]?.payload as { reinstall?: boolean })?.reinstall).toBe(true);
  });
});

// Hush an unused-import lint for Prisma (used to disambiguate error types
// in some tests' rejection messages downstream when expanded). For the
// six tests above we narrow exclusively by message regex, so Prisma is
// only used for the type imports above. Suppress in case it's flagged:
void Prisma;
