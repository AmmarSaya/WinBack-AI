import type { WinbackPrisma } from '@winback/db';
import type { EmailProvider } from '@winback/email';
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
 * - `queues`: BullMQ Queue handles. No order/attribution producer today
 *   (CP-2 §Q1 makes the drainer do that work inline rather than via a
 *   queue); the `cron.*` queues remain for the scheduler app.
 * - `shopifyConfig`: source of `ENCRYPTION_KEY` for the per-handler
 *   Cipher + AdminClient construction (merchant handler).
 * - `emailProvider`: the ESP boundary (Epic G batch 8.4). Single instance
 *   per process — the dispatch worker (`workers/dispatch.worker.ts`) calls
 *   `emailProvider.send(...)` to dispatch an email; tests inject a mocked
 *   provider through this field instead of standing up SES.
 * - `emailFromAddress` + `emailConfigurationSetName`: SES per-send config
 *   that's constant for the lifetime of the process (env-supplied at
 *   boot). Carried alongside the provider so the worker doesn't re-read
 *   env every dispatch.
 */
export interface DrainerContext {
  readonly prisma: WinbackPrisma;
  readonly queues: Queues;
  readonly shopifyConfig: ShopifyConfig;
  readonly emailProvider: EmailProvider;
  readonly emailFromAddress: string;
  readonly emailConfigurationSetName: string | undefined;
}
