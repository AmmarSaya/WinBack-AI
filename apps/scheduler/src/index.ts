/**
 * Scheduler process entry.
 *
 * Lifecycle:
 *
 *   1. Read config + construct SchedulerContext.
 *   2. Build BullMQ Workers on `cron.rollup` and `cron.sweep`.
 *   3. Register repeatable jobs (idempotent — BullMQ deduplicates by
 *      name+pattern/every).
 *   4. Install SIGTERM / SIGINT handlers.
 *   5. Process runs indefinitely.
 *
 * Graceful shutdown (same lesson as the drainer):
 *   - worker.close() — DEFAULT graceful, waits for in-flight tick.
 *     Do NOT pass `true` (that's the force variant — aborts in-flight).
 *   - closeQueues() — closes shared Queue ioredis client.
 *   - disconnectPrisma() — releases DB pool.
 *
 * Order: rollup worker → sweep worker → queues → prisma. Each step is
 * idempotent over double-call. Double-shutdown guard via `shuttingDown`
 * flag.
 */

import { getLogger } from '@winback/logger';
import { closeQueues, getQueues } from '@winback/queue';
import { getShopifyConfig } from '@winback/shopify';

import type { SchedulerContext } from './context.js';
import { disconnectPrisma, getPrisma } from './db.js';
import { registerRollupRepeat, registerSweepRepeat } from './scheduling.js';
import { createRollupWorker } from './workers/rollup-worker.js';
import { createSweepWorker } from './workers/sweep-worker.js';

const log = getLogger('scheduler.main');

async function main(): Promise<void> {
  log.info('scheduler: starting');

  const shopifyConfig = getShopifyConfig();
  const prisma = getPrisma();
  const queues = getQueues();

  const ctx: SchedulerContext = { prisma, queues, shopifyConfig };

  const rollupWorker = createRollupWorker(ctx);
  const sweepWorker = createSweepWorker(ctx);

  await registerRollupRepeat(queues.cronRollup);
  await registerSweepRepeat(queues.cronSweep);

  log.info(
    {
      rollupCadence: 'cron pattern 0 * * * * (hourly at minute 0 UTC)',
      sweepCadence: 'every 15 min (interval)',
    },
    'scheduler: repeatable jobs registered; workers running',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      log.warn({ signal }, 'scheduler: shutdown already in progress; ignoring signal');
      return;
    }
    shuttingDown = true;
    log.info({ signal }, 'scheduler: shutdown initiated');

    try {
      await rollupWorker.close();
      log.info('scheduler: rollup worker closed');
    } catch (err) {
      log.error({ err }, 'scheduler: rollup worker close threw');
    }

    try {
      await sweepWorker.close();
      log.info('scheduler: sweep worker closed');
    } catch (err) {
      log.error({ err }, 'scheduler: sweep worker close threw');
    }

    try {
      await closeQueues();
      log.info('scheduler: queues closed');
    } catch (err) {
      log.error({ err }, 'scheduler: closeQueues threw');
    }

    try {
      await disconnectPrisma();
      log.info('scheduler: prisma disconnected');
    } catch (err) {
      log.error({ err }, 'scheduler: prisma disconnect threw');
    }

    log.info('scheduler: shutdown complete');
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
  log.error({ err }, 'scheduler: fatal startup error');
  process.exit(1);
});
