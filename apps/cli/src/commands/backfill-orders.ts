/**
 * `pnpm cli:backfill:orders --merchant <merchantId>`
 *
 * Operator command to backfill a merchant's full Shopify order history into
 * the local `Order` + `OrderLineItem` tables. The heavy lifting is the
 * resumable `BackfillRunner` + the `OrderPageFetcher`/`OrderPageProcessor`
 * pair in `@winback/shopify`.
 *
 * WHY THIS EXISTS: scoring is webhook-forward-only — `readCohort` reads the
 * local `Order` table, which only fills from `orders/create` webhooks AFTER
 * install. A merchant's PRE-INSTALL order history is otherwise invisible, so
 * `bulkRescore` would score the whole base as account-age lurkers. Run this
 * BEFORE the first `cli:scoring:bulk-rescore` (or run it then re-score with
 * `--force`) so the cohort reflects real revenue.
 *
 * SILENT: the processor calls `OrderRepository.upsertFromWebhook` directly
 * (not the drainer handler), so backfilled orders do NOT trigger per-order
 * recompute. Scoring happens once afterward via `cli:scoring:bulk-rescore`.
 *
 * OPS — this is the FIRST CLI command that hits the Shopify Admin API. It
 * needs MORE env than the DB-only commands: in ONE shell set
 *   DATABASE_URL      (prisma + the merchant's offline token row)
 *   ENCRYPTION_KEY    (AES-256-GCM key to decrypt Session.accessToken)
 *   + the rest of getShopifyConfig()'s required vars (API key/secret/scopes).
 * Missing any of these fails at AdminClient construction, not mid-run.
 *
 * Scope: the merchant-existence check runs in `withTenantScope(merchantId)`;
 * `BackfillRunner.run` opens its OWN tenant scope internally (so we do not
 * nest — the check is scoped separately, then the runner runs).
 */

import { type WinbackPrisma, withTenantScope } from '@winback/db';
import {
  BackfillRunner,
  ORDER_BACKFILL_RESOURCE,
  OrderPageFetcher,
  OrderPageProcessor,
  buildAdminClient,
  type ShopifyOrderNode,
} from '@winback/shopify';

export type BackfillOrdersCommandResult =
  | { kind: 'merchant_not_found' }
  | {
      kind: 'backfilled';
      merchantId: string;
      pagesProcessed: number;
      itemsProcessed: number;
      finalStatus: 'completed' | 'paused' | 'failed';
    };

export interface RunBackfillOrdersArgs {
  readonly prisma: WinbackPrisma;
  readonly merchantId: string;
}

export async function runBackfillOrders(
  args: RunBackfillOrdersArgs,
): Promise<BackfillOrdersCommandResult> {
  const { prisma, merchantId } = args;

  // Existence check (scoped). The runner FKs BackfillJob → Merchant, so a
  // non-existent merchant would fail opaquely in getOrCreate; check first.
  const merchant = await withTenantScope(merchantId, async () =>
    prisma.merchant.findUnique({ where: { id: merchantId }, select: { id: true } }),
  );
  if (merchant === null) {
    return { kind: 'merchant_not_found' };
  }

  // buildAdminClient resolves shopify config from env + the merchant's
  // decrypted offline token from the DB (PrismaShopifyTokenResolver).
  const adminClient = buildAdminClient(prisma);
  const runner = new BackfillRunner<ShopifyOrderNode>(
    prisma,
    new OrderPageFetcher(adminClient),
    new OrderPageProcessor(),
  );

  // run() opens its own withTenantScope(merchantId); not nested with the
  // existence check above.
  const result = await runner.run({ merchantId, resource: ORDER_BACKFILL_RESOURCE });

  return {
    kind: 'backfilled',
    merchantId,
    pagesProcessed: result.pagesProcessed,
    itemsProcessed: result.itemsProcessed,
    finalStatus: result.finalStatus,
  };
}
