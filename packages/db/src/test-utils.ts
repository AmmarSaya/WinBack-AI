import { createWinbackPrisma, type WinbackPrisma } from './client.js';
import { withSystemScope } from './tenant-scope.js';

/**
 * Shared integration-test harness helpers.
 *
 * Used by `pnpm db:test`, `pnpm web:test`, and `pnpm drainer:test`. Each
 * consumer's test suite runs against the same Docker Postgres
 * (`postgresql://winback:winback@localhost:5433/winback_test`) via a
 * shared Prisma client (singleFork-per-suite — one client per process).
 *
 * History: these helpers lived in duplicate inside
 * `packages/db/tests/integration/setup.ts` and
 * `apps/web/tests/integration/setup.ts`. The drainer harness made it
 * three callers — extracted here per the session-1 setup.ts comment
 * ("if a third caller needs the same helpers later, extract"). One
 * source of truth for the FK-safe deleteMany order means schema
 * additions don't drift between consumers.
 *
 * Sub-exported as `@winback/db/test-utils` so cross-package consumers
 * (`apps/web`, `apps/drainer`) import via the package boundary;
 * `packages/db`'s own integration tests can use a relative path if
 * preferred but the sub-export works just as well from inside the
 * package.
 *
 * `test.*` scope reasons go through `withSystemScope`'s typed
 * template-literal escape — they are NOT registered in
 * `SYSTEM_SCOPE_REASONS` by design (rule 36 carve-out for tests).
 */

let _client: WinbackPrisma | null = null;

/**
 * Process-shared Prisma client. Vitest config sets `singleFork: true` so
 * the entire suite reuses one client — avoids connection-pool blowup at
 * tens-of-tests scale and keeps the integration-test runtime bounded by
 * DB work, not connect overhead.
 */
export function getTestClient(): WinbackPrisma {
  if (_client === null) {
    _client = createWinbackPrisma();
  }
  return _client;
}

/**
 * Truncate every business table in FK-safe order. Runs in `test.cleanup`
 * scope (cross-tenant deleteMany is legal only under system scope).
 *
 * Order matters — child relations before parents — per the
 * `schema.prisma` FK graph. Every FK is CASCADE or SetNull so the
 * trailing `merchant.deleteMany` cascade would also suffice; the
 * explicit order is defensive against future schema additions that
 * introduce a RESTRICT FK.
 *
 * Models with CASCADE FK from Merchant (currently `BackfillJob`) are
 * intentionally omitted from the explicit list; the trailing
 * `merchant.deleteMany` cleans them via cascade. Add to the explicit
 * list if a future FK turns RESTRICT.
 *
 * `Session` is the Shopify SDK adapter table — keyed on shop, NOT
 * FK'd to Merchant. It IS in the explicit list because the OAuth
 * callback in apps/web writes Session rows that wouldn't otherwise
 * be cleared between tests. Consumers that never write Session
 * (`packages/db`'s tests, drainer tests) eat a sub-ms DELETE on an
 * empty table per test — irrelevant cost, removes any divergence
 * risk between the three consumers.
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
    // Epic F batch 1 tables. Order matters within this trio: Message has
    // FK to AiGeneration (CASCADE), AiGeneration has FK to Customer
    // (CASCADE), so Message → AiGeneration → Customer is the FK-safe
    // sequence. AiSpendBucket has no Customer FK (only Merchant
    // CASCADE), so its position before Customer is mechanical not
    // load-bearing. The Merchant CASCADE chain at the end would clean
    // all three implicitly; explicit-list convention per file header.
    await client.message.deleteMany({});
    await client.aiGeneration.deleteMany({});
    await client.aiSpendBucket.deleteMany({});
    await client.customer.deleteMany({});
    await client.billingSubscription.deleteMany({});
    await client.merchantSettings.deleteMany({});
    await client.session.deleteMany({});
    await client.merchant.deleteMany({});
  });
}

/**
 * Wrap a cross-tenant read in `withSystemScope('test.assert', …)` with
 * the async-callback discipline baked in. Use in tests that query the
 * DB to verify outcomes — never call `withSystemScope` directly with a
 * sync arrow returning a promise, that's the b6431dc bug class the
 * harness exists to catch (rule #7 in ARCHITECTURE.md).
 */
export async function assertRead<T>(fn: () => Promise<T>): Promise<T> {
  return withSystemScope('test.assert', async () => await fn());
}

/**
 * Create a Merchant + MerchantSettings + BillingSubscription for a test,
 * returning its id. Bypasses the install flow — for tests that need a
 * pre-existing merchant without going through OAuth.
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
