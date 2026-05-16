/**
 * Repeatable-job registration for the scheduler.
 *
 * Two distinct BullMQ repeat mechanisms — note the difference:
 *
 *   - Rollup: `repeat: { pattern: '0 * * * *' }` — CRON SYNTAX.
 *     Fires at minute 0 of every UTC hour. Aligned with wall clock,
 *     not with process startup. Required for CP-2 §Q5's "single
 *     UTC-clock job" semantic; merchants at a given timezone offset
 *     are processed together at the same UTC hour.
 *
 *   - Sweep: `repeat: { every: 15 * 60 * 1000 }` — INTERVAL MS.
 *     Fires every 15 minutes from the first registration. Aligned with
 *     "since startup," not with wall clock. Correct for the enrichment
 *     sweep because the 10-min `installedAt` floor means any wall-clock
 *     anchor is irrelevant — the only thing that matters is "how long
 *     since we last swept."
 *
 * BullMQ deduplicates repeatable registrations by `(name, pattern|every,
 * tz)`. Calling registerRollupRepeat / registerSweepRepeat at every
 * process start is idempotent — the same repeatable key isn't duplicated
 * across restarts.
 *
 * Test locks (see [scheduling.test.ts](apps/scheduler/tests/scheduling.test.ts))
 * verify these specific shapes — a regression that flips pattern ↔ every
 * would fire the wrong tick cadence on whichever queue got swapped.
 */

import type { Queue } from 'bullmq';

export const ROLLUP_JOB_NAME = 'rollup-tick';
export const SWEEP_ENRICHMENT_JOB_NAME = 'enrichment-sweep';

/** CP-2 §Q5: hourly at minute 0 UTC. */
export const ROLLUP_CRON_PATTERN = '0 * * * *';

/** 15 minutes — covers the 10-min `installedAt` floor with ~5 min worst-case lag. */
export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export async function registerRollupRepeat(queue: Queue): Promise<void> {
  await queue.add(
    ROLLUP_JOB_NAME,
    {},
    { repeat: { pattern: ROLLUP_CRON_PATTERN } },
  );
}

export async function registerSweepRepeat(queue: Queue): Promise<void> {
  await queue.add(
    SWEEP_ENRICHMENT_JOB_NAME,
    {},
    { repeat: { every: SWEEP_INTERVAL_MS } },
  );
}
