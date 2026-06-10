/**
 * BullMQ Worker on `cron.sweep`.
 *
 * Dispatches by `job.name` so future sweep types (idempotency cleanup,
 * backfill recovery) can land on the same queue without a new queue
 * registration. Sweep types today:
 *
 *   - `'enrichment-sweep'` → runEnrichmentSweep (every 15 min)
 *   - `'decay-sweep'`      → runDecaySweep      (daily 03:00 UTC)
 *
 * The two coexist on one queue with different repeat cadences (BullMQ
 * deduplicates repeatables by name+pattern/every).
 *
 * Unknown job names: log + return (no throw). A rolling deploy where
 * the producer adds a new sweep type before the consumer knows about
 * it should degrade gracefully — the next deploy adds the handler.
 *
 * CONNECTION + CONCURRENCY: same pattern as the rollup worker.
 * LOCK DURATION: 10 minutes (sweep is generally faster than rollup;
 * enrichInstall is one HTTP round-trip per merchant).
 */

import { QUEUE_NAMES } from '@winback/contracts';
import { getLogger } from '@winback/logger';
import { createRedisClient } from '@winback/queue';
import { Worker, type Job } from 'bullmq';

import type { SchedulerContext } from '../context.js';
import { runDecaySweep } from '../handlers/decay-sweep.js';
import { runEnrichmentSweep } from '../handlers/enrichment-sweep.js';
import { SWEEP_DECAY_JOB_NAME, SWEEP_ENRICHMENT_JOB_NAME } from '../scheduling.js';

const log = getLogger('scheduler.worker.sweep');

const WORKER_CONCURRENCY = 1;
const WORKER_LOCK_DURATION_MS = 10 * 60 * 1000;

export function createSweepWorker(ctx: SchedulerContext): Worker {
  const connection = createRedisClient('worker.cron-sweep');

  const worker = new Worker(
    QUEUE_NAMES.cron.sweep,
    async (job: Job) => {
      switch (job.name) {
        case SWEEP_ENRICHMENT_JOB_NAME:
          await runEnrichmentSweep(ctx);
          return;
        case SWEEP_DECAY_JOB_NAME:
          await runDecaySweep(ctx);
          return;
        default:
          log.warn(
            { jobName: job.name, jobId: job.id },
            'sweep worker: unknown job name (no handler registered)',
          );
          return;
      }
    },
    {
      connection,
      concurrency: WORKER_CONCURRENCY,
      lockDuration: WORKER_LOCK_DURATION_MS,
    },
  );

  worker.on('failed', (job, err) => {
    log.error(
      { jobId: job?.id, jobName: job?.name, err: err.message },
      'sweep worker: tick failed (BullMQ will retry per default policy; next 15-min tick is the natural recovery)',
    );
  });

  worker.on('error', (err) => {
    log.error({ err: err.message }, 'sweep worker: top-level error');
  });

  return worker;
}
