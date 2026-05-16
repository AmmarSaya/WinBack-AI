import type { WinbackPrisma } from '@winback/db';
import type { Queues } from '@winback/queue';
import type { ShopifyConfig } from '@winback/shopify';

/**
 * Per-process scheduler context — the dependencies the cron handlers need.
 *
 * Constructed once at process start ([index.ts](apps/scheduler/src/index.ts))
 * and passed through Worker job processors → handlers.
 *
 * Mirrors `apps/drainer/src/context.ts` (`DrainerContext`) shape — same
 * three fields are needed for cross-tenant DB access, queue handles, and
 * AdminClient construction in the enrichment-sweep handler.
 */
export interface SchedulerContext {
  readonly prisma: WinbackPrisma;
  readonly queues: Queues;
  readonly shopifyConfig: ShopifyConfig;
}
