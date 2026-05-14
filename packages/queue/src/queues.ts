import { QUEUE_NAMES } from '@winback/contracts';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import { createRedisClient } from './redis-client.js';
import type { Queues } from './types.js';

/**
 * BullMQ queue registry — gives consumers typed Queue handles for every
 * named queue in `QUEUE_NAMES`.
 *
 * Two Queues today (`outbox.drain`, `attribution.compute`), growing
 * additively as D3 registers `cron.*` names. Every Queue here shares ONE
 * ioredis client (the `'queues.shared'` connection, created lazily on
 * first `getQueues()` call). This is safe per BullMQ docs because Queue
 * uses non-blocking commands only.
 *
 * Workers and the future cache layer DO NOT share this client — they
 * call `createRedisClient` with their own connection name. See
 * `redis-client.ts` for the full sharing rule encoded as a header.
 *
 * Lifecycle:
 *   - `getQueues()` is sync, lazy-init, memoized. Repeated calls return
 *     the same `Queues` object reference. `getRedisConfig` validation
 *     runs synchronously on first call — boot fails loudly if the env
 *     is malformed.
 *   - `closeQueues()` is async, idempotent over double-call. It closes
 *     all Queue instances and quits the shared ioredis client, then
 *     clears the memoization. If called when nothing is open, it logs
 *     a warning and returns — keeps SIGTERM handlers simple, makes the
 *     double-shutdown case legible in production logs without throwing.
 *   - After `closeQueues()`, the next `getQueues()` RE-INITIALIZES
 *     fresh. This is intentional for test ergonomics. Production
 *     callers should not call `getQueues()` after `closeQueues()`; if
 *     they do, they get a fresh registry rather than a "closed Queue"
 *     error. Treat it as a safety valve, not a feature.
 */

let cachedQueues: Queues | null = null;
let sharedClient: Redis | null = null;

export function getQueues(): Queues {
  if (cachedQueues === null) {
    sharedClient = createRedisClient('queues.shared');
    cachedQueues = {
      outboxDrain: new Queue(QUEUE_NAMES.outbox.drain, {
        connection: sharedClient,
      }),
      attributionCompute: new Queue(QUEUE_NAMES.attribution.compute, {
        connection: sharedClient,
      }),
    };
  }
  return cachedQueues;
}

export async function closeQueues(): Promise<void> {
  if (cachedQueues === null && sharedClient === null) {
    // Double-close: caller's shutdown sequence fired twice (e.g. SIGTERM
    // then SIGINT during graceful drain, or a test forgot to track
    // whether it had opened queues). Silent no-op would be safe — but
    // logging makes the case legible in production when debugging
    // shutdown order. Not an error: idempotency over double-call is by
    // design.
    console.warn(
      '[@winback/queue] closeQueues() called when no queues were open. ' +
        'Likely a double-shutdown; not a bug.',
    );
    return;
  }

  // Null both module-level references in `finally` so a thrown close()
  // or quit() can't leave the module in a partial-cleanup state — e.g.
  // cachedQueues=null but sharedClient still set, where the NEXT
  // closeQueues() call would skip the queues block (already null) and
  // hit the warning branch, leaking the shared client forever. The
  // try/finally guarantees both fields are nulled even if either close
  // or quit throws.
  try {
    if (cachedQueues !== null) {
      await Promise.all([
        cachedQueues.outboxDrain.close(),
        cachedQueues.attributionCompute.close(),
      ]);
    }
    if (sharedClient !== null) {
      await sharedClient.quit();
    }
  } finally {
    cachedQueues = null;
    sharedClient = null;
  }
}
