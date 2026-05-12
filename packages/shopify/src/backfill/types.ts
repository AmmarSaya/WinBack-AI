import type { Prisma } from '@prisma/client';

/**
 * One page of results from a Shopify resource fetch. Cursor-paginated.
 */
export interface ResourcePage<TItem> {
  readonly items: readonly TItem[];
  readonly endCursor: string | null;
  readonly hasNextPage: boolean;
}

/**
 * Fetches a single page from Shopify. The runner calls this repeatedly,
 * each call going through AdminClient.graphql which gates EVERY request
 * through the CostTracker — that's the C5 guardrail #1, structurally
 * enforced by the only-call-path being through the admin client.
 */
export interface PageFetcher<TItem> {
  fetch(args: {
    merchantId: string;
    cursor: string | null;
    pageSize: number;
  }): Promise<ResourcePage<TItem>>;
}

/**
 * Processes one page's items within an active DB transaction. The runner
 * also commits the cursor/counters in this SAME transaction, so cursor
 * advancement is atomic with the page's row writes. If processItems
 * throws, the cursor never advances and the next run re-fetches the page
 * (idempotent upserts handle dup writes).
 */
export interface PageProcessor<TItem> {
  processItems(args: {
    tx: Prisma.TransactionClient;
    merchantId: string;
    items: readonly TItem[];
  }): Promise<void>;
}

/**
 * Result of a complete backfill run.
 */
export interface BackfillRunResult {
  readonly merchantId: string;
  readonly resource: string;
  readonly pagesProcessed: number;
  readonly itemsProcessed: number;
  readonly finalStatus: 'completed' | 'paused' | 'failed';
}
