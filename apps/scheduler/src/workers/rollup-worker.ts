/**
 * BullMQ Worker on `cron.rollup`.
 *
 * Consumes the hourly tick jobs produced by `registerRollupRepeat`
 * (see [scheduling.ts](apps/scheduler/src/scheduling.ts)). One Worker
 * call per tick — invokes `runRollupTick(ctx)`.
 *
 * CONNECTION RULE: Workers must have their own ioredis connection
 * (blocking commands stall shared clients). See packages/queue/src/
 * redis-client.ts header.
 *
 * CONCURRENCY: 1 — only one rollup tick per Worker process at a time.
 * The CP-2 §Q5 hourly cadence has no overlap concern; concurrency > 1
 * here would only matter under multi-replica horizontal scaling, which
 * we're not configured for in D3.
 *
 * LOCK DURATION: 15 minutes. The stub body is fast (logs only), but
 * H1's real rollup math may scan AttributionEvent for many merchants;
 * 15 min is a generous ceiling. Below the BullMQ default 30 min keeps
 * a runaway tick from blocking the next hour's slot.
 */

import { QUEUE_NAMES } from '@winback/contracts';
import { getLogger } from '@winback/logger';
import { createRedisClient } from '@winback/queue';
import { Worker } from 'bullmq';

import type { SchedulerContext } from '../context.js';
import { runRollupTick } from '../handlers/rollup-tick.js';

const log = getLogger('scheduler.worker.rollup');

const WORKER_CONCURRENCY = 1;
const WORKER_LOCK_DURATION_MS = 15 * 60 * 1000;

export function createRollupWorker(ctx: SchedulerContext): Worker {
  const connection = createRedisClient('worker.cron-rollup');

  const worker = new Worker(
    QUEUE_NAMES.cron.rollup,
    async () => {
      await runRollupTick(ctx);
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
      'rollup worker: tick failed (BullMQ will retry per default policy; next hour is the natural recovery)',
    );
  });

  worker.on('error', (err) => {
    log.error({ err: err.message }, 'rollup worker: top-level error');
  });

  return worker;
}
