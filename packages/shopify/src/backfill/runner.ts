import { OUTBOX_EVENTS, type BackfillResource } from '@winback/contracts';
import {
  BackfillJobRepository,
  UnitOfWork,
  type WinbackPrisma,
  withTenantScope,
} from '@winback/db';
import { getLogger } from '@winback/logger';

import { ShopifyTokenRevokedError } from '../admin/errors.js';
import type { BackfillRunResult, PageFetcher, PageProcessor } from './types.js';

const log = getLogger('shopify.backfill.runner');

/**
 * Tx timeout for one page. Defaults to 30s per the per-call-site guidance
 * in UnitOfWork — backfill pages can carry up to ~250 row upserts plus the
 * cursor update. 30s is generous; bulk-state-transition cap (60s) is the
 * next step up if profiling shows it.
 */
const PAGE_TX_TIMEOUT_MS = 30_000;

/**
 * Safety cap on iterations. Prevents an infinite loop if Shopify ever
 * returns `hasNextPage: true` with a cursor that doesn't advance. Should
 * never trip in practice; if it does, that's a Shopify-side bug we want
 * surfaced as a failed backfill, not a runaway worker.
 */
const MAX_PAGES_HARD_LIMIT = 10_000;

export interface BackfillRunnerOptions {
  readonly merchantId: string;
  /**
   * Typed against the canonical registry in @winback/contracts. Callers
   * use `BACKFILL_RESOURCES.customers` etc. — never string literals.
   */
  readonly resource: BackfillResource;
  readonly pageSize?: number;
}

/**
 * Resumable per-resource Shopify backfill.
 *
 * Loop:
 *   1. Load or create BackfillJob for (merchantId, resource).
 *   2. Mark started.
 *   3. While `hasNextPage`:
 *        a. PageFetcher.fetch(cursor)  ← gated by CostTracker via AdminClient
 *        b. UnitOfWork.run(timeout: 30s):
 *             - PageProcessor.processItems(tx, items)
 *             - BackfillJobRepository.commitPage(tx, ...) — cursor advances
 *               in the SAME tx (guardrail #2: atomicity)
 *   4. Mark completed + publish merchant.backfill_completed outbox event.
 *
 * Error handling:
 *   - ShopifyTokenRevokedError → job → paused; do not re-throw. The
 *     401 handler in AdminClient has already set Merchant.tokenRevokedAt
 *     and emitted merchant.needs_reauth.
 *   - Any other error → job → failed (attempts++); re-throw so the
 *     caller surfaces it.
 *
 * Idempotent re-run:
 *   - Completed jobs short-circuit: returns existing counters, no work.
 *   - Running jobs: assume orphaned; restart from persisted cursor.
 *   - Paused/failed jobs: resume from persisted cursor.
 */
export class BackfillRunner<TItem> {
  private readonly repo: BackfillJobRepository;
  private readonly uow: UnitOfWork;

  constructor(
    private readonly prisma: WinbackPrisma,
    private readonly fetcher: PageFetcher<TItem>,
    private readonly processor: PageProcessor<TItem>,
  ) {
    this.repo = new BackfillJobRepository(prisma);
    this.uow = new UnitOfWork(prisma);
  }

  async run(options: BackfillRunnerOptions): Promise<BackfillRunResult> {
    const { merchantId, resource, pageSize = 50 } = options;

    return withTenantScope(merchantId, async () => {
      const job = await this.repo.getOrCreate(merchantId, resource, pageSize);

      // Short-circuit on completed.
      if (job.status === 'completed') {
        log.info(
          { merchantId, resource, itemsProcessed: job.itemsProcessed },
          'backfill: already completed, skipping',
        );
        return {
          merchantId,
          resource,
          pagesProcessed: job.pagesProcessed,
          itemsProcessed: job.itemsProcessed,
          finalStatus: 'completed',
        };
      }

      await this.repo.markStarted(merchantId, resource);
      let cursor = job.cursor;
      let pagesProcessed = job.pagesProcessed;
      let itemsProcessed = job.itemsProcessed;

      try {
        let pageCount = 0;
        while (pageCount < MAX_PAGES_HARD_LIMIT) {
          // (1) Fetch — gated by CostTracker via AdminClient.
          const page = await this.fetcher.fetch({
            merchantId,
            cursor,
            pageSize: job.pageSize,
          });

          // (2) Atomic page commit: items + cursor + counters in one tx.
          await this.uow.run(
            async (ctx) => {
              if (page.items.length > 0) {
                await this.processor.processItems({
                  tx: ctx.db,
                  merchantId,
                  items: page.items,
                });
              }
              await this.repo.commitPage(ctx.db, {
                merchantId,
                resource,
                newCursor: page.endCursor,
                itemsInPage: page.items.length,
              });
            },
            { timeout: PAGE_TX_TIMEOUT_MS },
          );

          cursor = page.endCursor;
          pagesProcessed += 1;
          itemsProcessed += page.items.length;
          pageCount += 1;

          log.debug(
            { merchantId, resource, pagesProcessed, itemsProcessed },
            'backfill: page committed',
          );

          if (!page.hasNextPage) break;
        }

        if (pageCount >= MAX_PAGES_HARD_LIMIT) {
          throw new Error(
            `Backfill page limit (${String(MAX_PAGES_HARD_LIMIT)}) exceeded — likely a non-advancing cursor.`,
          );
        }

        // (3) Mark completed + publish summary event in one tx.
        await this.uow.run(async (ctx) => {
          await ctx.db.backfillJob.update({
            where: { merchantId_resource: { merchantId, resource } },
            data: { status: 'completed', completedAt: new Date(), lastError: null },
          });
          await ctx.publish(OUTBOX_EVENTS.merchant.backfill_completed, {
            resource,
            pagesProcessed,
            itemsProcessed,
          });
        });

        log.info(
          { merchantId, resource, pagesProcessed, itemsProcessed },
          'backfill: completed',
        );
        return {
          merchantId,
          resource,
          pagesProcessed,
          itemsProcessed,
          finalStatus: 'completed',
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof ShopifyTokenRevokedError) {
          log.warn(
            { merchantId, resource, message },
            'backfill: token revoked, pausing',
          );
          await this.repo.markPaused(merchantId, resource, message);
          return {
            merchantId,
            resource,
            pagesProcessed,
            itemsProcessed,
            finalStatus: 'paused',
          };
        }
        log.error({ err, merchantId, resource }, 'backfill: failed');
        await this.repo.markFailed(merchantId, resource, message);
        throw err;
      }
    });
  }
}
