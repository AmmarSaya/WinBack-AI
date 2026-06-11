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
export const SWEEP_DECAY_JOB_NAME = 'decay-sweep';
/** Epic G batch 8.2 — campaign dispatch sweep (15-min interval, on cron.sweep). */
export const SWEEP_DISPATCH_JOB_NAME = 'dispatch-sweep';

/** CP-2 §Q5: hourly at minute 0 UTC. */
export const ROLLUP_CRON_PATTERN = '0 * * * *';

/** 15 minutes — covers the 10-min `installedAt` floor with ~5 min worst-case lag. */
export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Decay-rescore sweep: daily at 03:00 UTC. CRON SYNTAX (wall-clock
 * aligned), NOT an interval — decay is calendar-anchored, so the sweep
 * must fire on a fixed wall-clock boundary, not "since startup."
 *
 * Cadence rationale: the recency-band thresholds (rDays = 30/90/180/365)
 * are DAY-granular, so a customer crosses at most one band boundary per
 * calendar day. A daily sweep catches every decay transition with no
 * finer granularity needed; hourly would be 24× wasted work finding
 * nothing new. 03:00 UTC is off-peak and safely past the midnight-UTC
 * day boundary so the day's rDays increment has settled.
 *
 * Registered on the SAME `cron.sweep` queue as the enrichment sweep
 * (the sweep worker dispatches by job name). BullMQ deduplicates
 * repeatables by (name, pattern, tz), so a daily cron-pattern job and a
 * 15-min interval job coexist on one queue without conflict.
 */
export const SWEEP_DECAY_CRON_PATTERN = '0 3 * * *';

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

export async function registerDecaySweepRepeat(queue: Queue): Promise<void> {
  await queue.add(
    SWEEP_DECAY_JOB_NAME,
    {},
    { repeat: { pattern: SWEEP_DECAY_CRON_PATTERN } },
  );
}

/**
 * Campaign dispatch sweep (Epic G batch 8.2): every 15 min. INTERVAL MS
 * (`every`), NOT a cron pattern — dispatch eligibility is "since-startup"
 * polling, not wall-clock-anchored (matches the enrichment sweep's mechanism).
 *
 * Registered on the SAME `cron.sweep` queue as the enrichment + decay sweeps;
 * the sweep worker dispatches by job name. BullMQ deduplicates repeatables by
 * (name, every, tz), so this 15-min interval job coexists with enrichment's
 * 15-min interval and decay's daily cron — distinct job NAMES keep them
 * separate even where the cadence matches.
 *
 * 15 min is the re-evaluation granularity that 8.3's quiet-hours gate will
 * ride on (out-of-window → re-queue → re-check next tick).
 */
export async function registerDispatchSweepRepeat(queue: Queue): Promise<void> {
  await queue.add(
    SWEEP_DISPATCH_JOB_NAME,
    {},
    { repeat: { every: SWEEP_INTERVAL_MS } },
  );
}
