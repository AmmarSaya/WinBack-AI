import type { Queue } from 'bullmq';

/**
 * Public type for the queue registry returned by `getQueues()`.
 *
 * Exported as a named interface so consumers (D2 Worker registration,
 * future code that accepts a Queue handle) can write
 *
 *   import type { Queues } from '@winback/queue';
 *
 * rather than inferring `ReturnType<typeof getQueues>`. A stable named
 * export is a stable API surface as the registry grows.
 *
 * The interface grows additively as new queues are registered (cron queues
 * landed in D3). Removing a field is a coordinated change — the C1 fix
 * dropped `attributionCompute` after CP-2 §Q1 made the drainer do
 * attribution work inline rather than via a queue + consumer.
 */
export interface Queues {
  readonly outboxDrain: Queue;
  readonly cronRollup: Queue;
  readonly cronSweep: Queue;
}
