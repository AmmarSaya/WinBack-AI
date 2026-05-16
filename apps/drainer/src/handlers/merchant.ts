/**
 * `merchant.installed` handler — runs initial post-install enrichment
 * (Merchant shop details: email/name/country/currency/timezone/plan) and
 * the initial customer backfill.
 *
 * SEQUENCING NOTE: this handler lives in `MARK_BEFORE_INVOKE_EVENTS`
 * (see `../ordering.ts`). The drainer marks the OutboxEvent row
 * processed BEFORE invoking this function, then commits, then calls
 * us OUT of the drainer transaction. We can therefore run for as long
 * as enrichment + paged backfill take (seconds-to-minutes for large
 * stores) without holding a database row lock.
 *
 * SCOPE: per design, the drainer does NOT wrap this in an outer
 * `withTenantScope`. Both `enrichInstall` and `BackfillRunner.run`
 * open their own internally. The callee owns scope management.
 *
 * Returns successfully on:
 *   - enrichInstall success or failure (the function does not throw;
 *     it returns `{success: false, reason}` which we log at warn
 *     level — D3 cron sweep owns enrichment retry).
 *   - BackfillRunner finalStatus 'completed' (normal) or 'paused'
 *     (token revoked; resumes on re-OAuth).
 *
 * Throws (propagates up to the drainer's out-of-tx invocation path):
 *   - BackfillRunner.run throws on any non-token-revoked error.
 *     BackfillJob state is persisted; manual replay or future D4 DLQ
 *     resumes from the cursor.
 *   - Zod parse failure on a malformed payload.
 *
 * AdminClient construction: built inline here (4 lines), matching the
 * pattern in apps/web/app/routes/auth.callback.tsx step 8b. N=2; not
 * yet earning an abstraction.
 */

import type { OutboxEventRow } from '@winback/db';
import { getLogger } from '@winback/logger';
import {
  BackfillRunner,
  CUSTOMER_BACKFILL_RESOURCE,
  CustomerPageFetcher,
  CustomerPageProcessor,
  buildAdminClient,
  enrichInstall,
  type ShopifyCustomerNode,
} from '@winback/shopify';

import type { DrainerContext } from '../context.js';
import { merchantInstalledPayloadSchema } from '../payload-schemas.js';

const log = getLogger('drainer.handler.merchant');

export async function handleMerchantInstalled(
  ctx: DrainerContext,
  row: OutboxEventRow,
): Promise<void> {
  const payload = merchantInstalledPayloadSchema.parse(row.payload);

  // (1) AdminClient — one instance reused by enrichInstall and the
  // customer-backfill fetcher. buildAdminClient encapsulates the
  // Cipher → resolver → tracker → AdminClient construction ritual
  // (promoted to @winback/shopify in D3 when the third call site
  // landed in apps/scheduler).
  const adminClient = buildAdminClient(ctx.prisma, ctx.shopifyConfig);

  // (2) Enrichment. enrichInstall returns `{success, reason?}` rather
  // than throwing. Log non-success at warn; do NOT throw — D3 cron
  // sweep owns enrichment retry once it ships. Until then, failed
  // enrichments stay un-retried and the health-check query
  // (`shopDetailsFetchedAt IS NULL`) surfaces them for operators.
  const enrichResult = await enrichInstall(ctx.prisma, adminClient, row.merchantId);
  if (!enrichResult.success) {
    log.warn(
      {
        eventId: row.id,
        merchantId: row.merchantId,
        shop: payload.shop,
        reason: enrichResult.reason,
      },
      'merchant.installed: enrichInstall failed — D3 cron sweep will retry',
    );
  } else {
    log.info(
      { eventId: row.id, merchantId: row.merchantId, shop: payload.shop },
      'merchant.installed: enrichment succeeded',
    );
  }

  // (3) Initial customer backfill. Reuses the same AdminClient — the
  // fetcher pages through Shopify's customers connection gated by the
  // shared CostTracker. The processor upserts only Shopify-owned
  // fields (see customer-backfill.ts SHOPIFY_OWNED_FIELDS).
  const fetcher = new CustomerPageFetcher(adminClient);
  const processor = new CustomerPageProcessor();
  const runner = new BackfillRunner<ShopifyCustomerNode>(ctx.prisma, fetcher, processor);

  const backfillResult = await runner.run({
    merchantId: row.merchantId,
    resource: CUSTOMER_BACKFILL_RESOURCE,
    // pageSize defaults to 50; let runner pick unless we have reason to override.
  });

  if (backfillResult.finalStatus === 'paused') {
    // Token revoked mid-backfill. Job state persisted as paused; resumes
    // on re-OAuth (or future D3 sweep). Not an error — log + return.
    log.warn(
      {
        eventId: row.id,
        merchantId: row.merchantId,
        pagesProcessed: backfillResult.pagesProcessed,
        itemsProcessed: backfillResult.itemsProcessed,
      },
      'merchant.installed: customer backfill paused (token revoked)',
    );
    return;
  }

  log.info(
    {
      eventId: row.id,
      merchantId: row.merchantId,
      pagesProcessed: backfillResult.pagesProcessed,
      itemsProcessed: backfillResult.itemsProcessed,
    },
    'merchant.installed: customer backfill completed',
  );
}
