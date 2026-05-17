import { createWinbackPrisma, withSystemScope, type WinbackPrisma } from '@winback/db';

/**
 * Shared harness setup for apps/web integration tests. Mirrors the pattern
 * in packages/db/tests/integration/setup.ts — same Docker Postgres
 * (:5433/winback_test), same singleFork shape (one Prisma client across the
 * suite), same FK-safe explicit deleteMany order.
 *
 * Duplicated rather than imported across packages because cross-package
 * test-file imports don't survive the TS project-reference build graph.
 * If a third caller needs the same helpers later, extract to a shared
 * `@winback/db/test-utils` sub-export then.
 *
 * test.* scope reasons go through withSystemScope's typed template-literal
 * escape — they're NOT registered in SYSTEM_SCOPE_REASONS by design.
 */

let _client: WinbackPrisma | null = null;

export function getTestClient(): WinbackPrisma {
  if (_client === null) {
    _client = createWinbackPrisma();
  }
  return _client;
}

/**
 * Truncate all tables in FK-safe order. Runs in `test.cleanup` scope.
 *
 * Order matters: children before parents, per schema.prisma FK graph.
 * Identical to packages/db's resetDb — keep them in sync when the
 * schema grows (Epic E/F/G add new models).
 *
 * Models with CASCADE FK from Merchant (currently `BackfillJob`) are
 * intentionally omitted; the trailing `merchant.deleteMany` cleans them
 * via cascade. Add to the explicit list if a future FK turns RESTRICT.
 */
export async function resetDb(): Promise<void> {
  const client = getTestClient();
  await withSystemScope('test.cleanup', async () => {
    await client.outboxEvent.deleteMany({});
    await client.idempotencyKey.deleteMany({});
    await client.auditLog.deleteMany({});
    await client.webhookLog.deleteMany({});
    await client.orderLineItem.deleteMany({});
    await client.order.deleteMany({});
    await client.productVariant.deleteMany({});
    await client.product.deleteMany({});
    await client.customer.deleteMany({});
    await client.billingSubscription.deleteMany({});
    await client.merchantSettings.deleteMany({});
    await client.merchant.deleteMany({});
  });
}

/**
 * Wrap a cross-tenant read in `withSystemScope('test.assert', …)` with the
 * async-callback discipline baked in. Use in tests that query the DB to
 * verify outcomes — never call `withSystemScope` directly with a
 * sync arrow returning a promise, that's the b6431dc bug class the
 * harness exists to catch (rule #7 in ARCHITECTURE.md).
 */
export async function assertRead<T>(fn: () => Promise<T>): Promise<T> {
  return withSystemScope('test.assert', async () => await fn());
}

/**
 * Create a Merchant + Settings + Subscription for a test, returning its id.
 * Mirrors packages/db's helper. Bypasses the install flow.
 */
export async function createTestMerchant(shop: string): Promise<string> {
  const client = getTestClient();
  return withSystemScope('test.setup_merchant', async () => {
    const m = await client.merchant.create({
      data: {
        shop,
        installedAt: new Date(),
        settings: { create: {} },
        billingSubscription: { create: { status: 'trialing' } },
      },
      select: { id: true },
    });
    return m.id;
  });
}
