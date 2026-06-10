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
 * Graceful shutdown (Q-B1: parallel worker close via Promise.allSettled
 * for per-worker error isolation + matching the drainer's batch-4
 * pattern at `apps/drainer/src/index.ts`):
 *   - rollupWorker.close() + sweepWorker.close() — PARALLEL via
 *     `Promise.allSettled`. Each finishes its in-flight tick + refuses
 *     new jobs (DEFAULT graceful close; do NOT pass `true` — that's the
 *     force variant which aborts in-flight). Per-worker errors logged
 *     but never block the rest of the shutdown.
 *   - closeQueues() — closes the shared Queue ioredis client AFTER both
 *     workers (workers may write back to the Queue handle during
 *     in-flight finish).
 *   - disconnectPrisma() — releases the DB pool LAST.
 *
 * Order: workers (parallel) → queues → prisma. Each step is idempotent
 * over double-call. Double-shutdown guard via `shuttingDown` flag.
 */

import { getLogger } from '@winback/logger';
import { closeQueues, getQueues } from '@winback/queue';
import { getShopifyConfig } from '@winback/shopify';

import type { SchedulerContext } from './context.js';
import { disconnectPrisma, getPrisma } from './db.js';
import {
  registerDecaySweepRepeat,
  registerRollupRepeat,
  registerSweepRepeat,
} from './scheduling.js';
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
  await registerDecaySweepRepeat(queues.cronSweep);

  log.info(
    {
      rollupCadence: 'cron pattern 0 * * * * (hourly at minute 0 UTC)',
      sweepCadence: 'every 15 min (interval)',
      decaySweepCadence: 'cron pattern 0 3 * * * (daily at 03:00 UTC)',
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

    // Q-B1 — PARALLEL worker close via Promise.allSettled. Both
    // Workers own independent ioredis connections (no shared resource
    // contention) so concurrent close is safe. Per-worker error
    // isolation: if one close throws, the other still completes + we
    // get separate log lines for each failure. Mirrors the drainer's
    // batch-4 pattern (apps/drainer/src/index.ts).
    const [rollupResult, sweepResult] = await Promise.allSettled([
      rollupWorker.close(),
      sweepWorker.close(),
    ]);
    if (rollupResult.status === 'rejected') {
      log.error(
        { err: rollupResult.reason },
        'scheduler: rollup worker close threw',
      );
    } else {
      log.info('scheduler: rollup worker closed');
    }
    if (sweepResult.status === 'rejected') {
      log.error(
        { err: sweepResult.reason },
        'scheduler: sweep worker close threw',
      );
    } else {
      log.info('scheduler: sweep worker closed');
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
