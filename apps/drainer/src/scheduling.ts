/**
 * Drainer tick scheduling — re-enqueue policy after each tick.
 *
 *   hasMore: true  → enqueue next tick immediately (work backlog;
 *                    drain at max throughput)
 *   hasMore: false → enqueue next tick with `delay: idleDelayMs`
 *                    (no work observed; slow-poll)
 *
 * This is the elasticity mechanism: tick cadence adapts to backlog
 * without configuring a fixed cron interval. The alternative (BullMQ
 * repeatable jobs at a fixed period) is simpler but always-on at a
 * single rate.
 *
 * Job name `tick` is stable across enqueues so BullMQ groups all
 * tick jobs as a single class in its UI / observability surfaces.
 */

import type { Queue } from 'bullmq';

export const DEFAULT_IDLE_DELAY_MS = 1_000;

export interface DrainTickJobData {
  /** Wall-clock timestamp at enqueue (for forensic correlation). */
  readonly enqueuedAt: number;
  /** True if this was the process-startup tick (vs. self-re-enqueue). */
  readonly initial?: boolean;
}

export async function enqueueNextTick(
  queue: Queue,
  hasMore: boolean,
  idleDelayMs: number = DEFAULT_IDLE_DELAY_MS,
): Promise<void> {
  const data: DrainTickJobData = { enqueuedAt: Date.now() };
  const opts = hasMore ? {} : { delay: idleDelayMs };
  await queue.add('tick', data, opts);
}

export async function enqueueInitialTick(queue: Queue): Promise<void> {
  const data: DrainTickJobData = { enqueuedAt: Date.now(), initial: true };
  await queue.add('tick', data);
}
