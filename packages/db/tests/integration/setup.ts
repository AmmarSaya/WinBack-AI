import { createWinbackPrisma, withSystemScope } from '../../src/index.js';

let _client: ReturnType<typeof createWinbackPrisma> | null = null;

/**
 * Shared Prisma client for the integration suite. Built once per fork; the
 * vitest config uses `singleFork: true` so all tests share the same
 * connection pool and avoid DB-side contention.
 */
export function getTestClient(): ReturnType<typeof createWinbackPrisma> {
  if (_client === null) {
    _client = createWinbackPrisma();
  }
  return _client;
}

/**
 * Hard reset between test fixtures. Deletes in FK-safe order. Runs in
 * `withSystemScope` because the cleanup spans tenants by design.
 *
 * Not a tx — deleteMany operations are fast; failure mid-cleanup is rare
 * and recoverable by re-running. Keeping it simple for the smoke suite.
 *
 * Order is INTENTIONAL — children before parents, per the FK graph in
 * schema.prisma v2.2:
 *
 *   1. OrderLineItem / OutboxEvent / IdempotencyKey / WebhookLog / AuditLog
 *      (no further children)
 *   2. Order / ProductVariant (children of higher rows already gone)
 *   3. Product / Customer (children of Merchant)
 *   4. BillingSubscription / MerchantSettings (siblings)
 *   5. Merchant (last)
 *
 * Every FK is CASCADE or SetNull, so `DELETE FROM Merchant` cascade would
 * also work — but the explicit order is defensive against future schema
 * additions that introduce a RESTRICT FK. It also avoids intermittent
 * "fails only on second run" failures, where a misordered delete violates
 * a constraint left dangling by a prior partial cleanup.
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
 * Creates a Merchant + Settings + Subscription for a test, returning its
 * id. Used by tests that don't go through the full install flow.
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
