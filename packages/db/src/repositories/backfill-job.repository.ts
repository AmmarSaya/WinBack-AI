import type { BackfillJob, BackfillStatus, Prisma } from '@prisma/client';

import { assertScopeMatchesMerchant } from '../tenant-scope.js';
import { BaseRepository } from './base.js';

/**
 * Repository for the BackfillJob table.
 *
 * Used by the backfill runner in @winback/shopify to:
 *   1. Find or create a job row for (merchantId, resource).
 *   2. Atomically commit a page's `cursor` + counters with the page's
 *      domain writes inside a single UnitOfWork transaction.
 *   3. Move the job into terminal states (completed / paused / failed)
 *      with appropriate side effects logged.
 *
 * All operations assert tenant scope explicitly because BackfillJob is a
 * tenant-scoped model and many callers use `withSystemScope` (the runner
 * itself runs in system scope while iterating across merchants).
 */
export class BackfillJobRepository extends BaseRepository {
  /**
   * Returns the existing job for (merchantId, resource), or creates a new
   * pending row if none exists.
   */
  async getOrCreate(
    merchantId: string,
    resource: string,
    pageSize: number,
  ): Promise<BackfillJob> {
    assertScopeMatchesMerchant(merchantId);
    return this.prisma.backfillJob.upsert({
      where: { merchantId_resource: { merchantId, resource } },
      create: { merchantId, resource, pageSize },
      update: {},
    });
  }

  async findByResource(merchantId: string, resource: string): Promise<BackfillJob | null> {
    assertScopeMatchesMerchant(merchantId);
    return this.prisma.backfillJob.findUnique({
      where: { merchantId_resource: { merchantId, resource } },
    });
  }

  async markStarted(merchantId: string, resource: string): Promise<void> {
    assertScopeMatchesMerchant(merchantId);
    await this.prisma.backfillJob.update({
      where: { merchantId_resource: { merchantId, resource } },
      data: { status: 'running', startedAt: new Date(), lastError: null },
    });
  }

  /**
   * Commits a page's progress atomically. The CALLER is responsible for
   * running this inside the same transaction as the domain writes for the
   * page — i.e., pass a `Prisma.TransactionClient` from a `UnitOfWork.run`
   * callback. That's the guarantee that "cursor advances iff items
   * landed" — if either side fails, both roll back.
   */
  async commitPage(
    tx: Prisma.TransactionClient,
    args: {
      merchantId: string;
      resource: string;
      newCursor: string | null;
      itemsInPage: number;
    },
  ): Promise<void> {
    await tx.backfillJob.update({
      where: {
        merchantId_resource: { merchantId: args.merchantId, resource: args.resource },
      },
      data: {
        cursor: args.newCursor,
        itemsProcessed: { increment: args.itemsInPage },
        pagesProcessed: { increment: 1 },
      },
    });
  }

  async markCompleted(merchantId: string, resource: string): Promise<void> {
    assertScopeMatchesMerchant(merchantId);
    await this.prisma.backfillJob.update({
      where: { merchantId_resource: { merchantId, resource } },
      data: { status: 'completed', completedAt: new Date(), lastError: null },
    });
  }

  async markPaused(merchantId: string, resource: string, error: string): Promise<void> {
    assertScopeMatchesMerchant(merchantId);
    await this.prisma.backfillJob.update({
      where: { merchantId_resource: { merchantId, resource } },
      data: { status: 'paused', lastError: error.slice(0, 1000) },
    });
  }

  async markFailed(merchantId: string, resource: string, error: string): Promise<void> {
    assertScopeMatchesMerchant(merchantId);
    await this.prisma.backfillJob.update({
      where: { merchantId_resource: { merchantId, resource } },
      data: {
        status: 'failed',
        attempts: { increment: 1 },
        lastError: error.slice(0, 1000),
      },
    });
  }
}

export type { BackfillJob, BackfillStatus };
