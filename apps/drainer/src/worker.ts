/**
 * BullMQ Worker on `outbox.drain` — consumes "tick" jobs and runs one
 * `runDrainTick` per job. After each tick, re-enqueues the next tick
 * via `enqueueNextTick` (immediate if hasMore, delayed if idle).
 *
 * CONNECTION RULE: Workers must have their own ioredis connection
 * (blocking commands stall shared clients). See packages/queue/src/
 * redis-client.ts header. We call createRedisClient with a descriptive
 * name so the connection is identifiable in `CLIENT LIST` output.
 *
 * CONCURRENCY: 1 — only one tick runs at a time per Worker process.
 * Horizontal scaling is via additional apps/drainer process replicas;
 * SKIP LOCKED in `claimBatch` prevents double-processing across
 * replicas. Concurrency > 1 inside a single Worker would require
 * cross-tick coordination we don't need yet.
 *
 * LOCK DURATION: generous (30 minutes) because deferred-handler events
 * (merchant.installed → BackfillRunner, gdpr.shop_redacted → chunked
 * deletes) can run for several minutes on large stores. If a single
 * tick exceeds 30 minutes, BullMQ assumes the worker died and re-queues
 * the job — duplicate processing then becomes a real concern. The
 * BackfillJob's `getOrCreate + status check` and processShopRedact's
 * idempotency provide safety, but the lock-duration setting is the
 * first line of defence.
 */

import { QUEUE_NAMES } from '@winback/contracts';
import { getLogger } from '@winback/logger';
import { createRedisClient } from '@winback/queue';
import { Worker, type Job } from 'bullmq';

import type { DrainerContext } from './context.js';
import { runDrainTick } from './drainer.js';
import { enqueueNextTick, type DrainTickJobData } from './scheduling.js';

const log = getLogger('drainer.worker');

const WORKER_CONCURRENCY = 1;
const WORKER_LOCK_DURATION_MS = 30 * 60 * 1000;

export function createDrainerWorker(ctx: DrainerContext): Worker<DrainTickJobData> {
  const connection = createRedisClient('worker.outbox-drain');

  const worker = new Worker<DrainTickJobData>(
    QUEUE_NAMES.outbox.drain,
    async (job: Job<DrainTickJobData>) => {
      const startedAt = Date.now();
      log.debug({ jobId: job.id, enqueuedAt: job.data.enqueuedAt }, 'tick: start');

      const result = await runDrainTick(ctx);

      // Re-enqueue next tick onto the same queue we're consuming.
      // The Queue handle on ctx.queues.outboxDrain is the producer
      // counterpart of this Worker.
      await enqueueNextTick(ctx.queues.outboxDrain, result.hasMore);

      log.info(
        {
          jobId: job.id,
          claimed: result.claimed,
          hasMore: result.hasMore,
          durationMs: Date.now() - startedAt,
        },
        'tick: done',
      );
      return result;
    },
    {
      connection,
      concurrency: WORKER_CONCURRENCY,
      lockDuration: WORKER_LOCK_DURATION_MS,
    },
  );

  worker.on('failed', (job, err) => {
    log.error(
      { jobId: job?.id, err: err.message },
      'drainer worker: tick job failed (BullMQ will retry per default policy)',
    );
  });

  worker.on('error', (err) => {
    log.error({ err: err.message }, 'drainer worker: top-level error');
  });

  return worker;
}
