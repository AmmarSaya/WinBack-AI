/**
 * Drainer process entry.
 *
 * Lifecycle:
 *
 *   1. Read config (Shopify, ENCRYPTION_KEY, Redis).
 *   2. Construct DrainerContext (prisma, queues, shopifyConfig).
 *   3. Build BullMQ Worker on `outbox.drain`.
 *   4. Enqueue one initial tick job (the worker self-re-enqueues thereafter).
 *   5. Install SIGTERM / SIGINT handlers for graceful shutdown.
 *   6. Process runs indefinitely.
 *
 * Graceful shutdown:
 *   - worker.close(true) — finishes the in-flight tick, refuses new jobs.
 *   - closeQueues() — closes the shared Queue handles + their ioredis client.
 *   - disconnectPrisma() — releases DB pool.
 *
 * The order matters: we want the Worker to finish first so it doesn't
 * grab another job while Queues are closing. closeQueues runs after, then
 * Prisma. Each step is idempotent over double-call.
 */

import { getLogger } from '@winback/logger';
import { closeQueues, getQueues } from '@winback/queue';
import { getShopifyConfig } from '@winback/shopify';

import type { DrainerContext } from './context.js';
import { disconnectPrisma, getPrisma } from './db.js';
import { enqueueInitialTick } from './scheduling.js';
import { createDrainerWorker } from './worker.js';

const log = getLogger('drainer.main');

async function main(): Promise<void> {
  log.info('drainer: starting');

  const shopifyConfig = getShopifyConfig();
  const prisma = getPrisma();
  const queues = getQueues();

  const ctx: DrainerContext = { prisma, queues, shopifyConfig };
  const worker = createDrainerWorker(ctx);

  await enqueueInitialTick(queues.outboxDrain);
  log.info('drainer: initial tick enqueued; worker running');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      log.warn({ signal }, 'drainer: shutdown already in progress; ignoring signal');
      return;
    }
    shuttingDown = true;
    log.info({ signal }, 'drainer: shutdown initiated');

    try {
      await worker.close();
      log.info('drainer: worker closed');
    } catch (err) {
      log.error({ err }, 'drainer: worker close threw');
    }

    try {
      await closeQueues();
      log.info('drainer: queues closed');
    } catch (err) {
      log.error({ err }, 'drainer: closeQueues threw');
    }

    try {
      await disconnectPrisma();
      log.info('drainer: prisma disconnected');
    } catch (err) {
      log.error({ err }, 'drainer: prisma disconnect threw');
    }

    log.info('drainer: shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

main().catch((err: unknown) => {
  // Top-level failure (config validation, Redis unreachable at boot, etc.).
  // Log + exit non-zero so the orchestrator restarts the process.
  log.error({ err }, 'drainer: fatal startup error');
  process.exit(1);
});
