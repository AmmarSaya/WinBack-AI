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
 * When D3 adds cron.* queues, this interface grows additively. Existing
 * consumers that destructure `outboxDrain` / `attributionCompute` stay
 * compatible — they just won't know about the new fields until they're
 * destructured.
 */
export interface Queues {
  readonly outboxDrain: Queue;
  readonly attributionCompute: Queue;
  readonly cronRollup: Queue;
  readonly cronSweep: Queue;
}
