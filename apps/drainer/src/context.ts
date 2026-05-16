import type { WinbackPrisma } from '@winback/db';
import type { Queues } from '@winback/queue';
import type { ShopifyConfig } from '@winback/shopify';

/**
 * Per-process drainer context — the dependencies a handler may need.
 *
 * Constructed once at process start ([index.ts](apps/drainer/src/index.ts))
 * and passed through dispatch → handler. Keeping the type small means
 * tests can construct stub contexts without faking an entire process
 * environment.
 *
 * - `prisma`: the extended Prisma client. Handlers pass this to
 *   compliance / shopify functions that take `WinbackPrisma`.
 * - `queues`: BullMQ Queue handles. The order handler enqueues
 *   `attribution.compute` jobs through `queues.attributionCompute`.
 * - `shopifyConfig`: source of `ENCRYPTION_KEY` for the per-handler
 *   Cipher + AdminClient construction (merchant handler).
 */
export interface DrainerContext {
  readonly prisma: WinbackPrisma;
  readonly queues: Queues;
  readonly shopifyConfig: ShopifyConfig;
}
