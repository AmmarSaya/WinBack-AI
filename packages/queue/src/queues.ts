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

/**
 * INTERNAL — exposes the shared ioredis client reference for integration
 * testing only. Returns the current `sharedClient`, or null if either
 * `getQueues()` has not been called yet or `closeQueues()` has run since
 * the last `getQueues()`.
 *
 * NOT re-exported from `index.ts`. Production code MUST NOT call this —
 * the sanctioned API is `getQueues()` for Queue handles. The integration
 * suite (step 5) needs access to the shared client to assert its
 * post-close `status === 'end'` (BullMQ Queue.add doesn't reliably throw
 * after close in 5.76.8, so this is the load-bearing assertion that
 * closeQueues actually disconnected ioredis).
 *
 * The leading double-underscore + `ForTesting` suffix make the intent
 * grep-clear: any production grep for `__getSharedClientForTesting` is
 * a code-review red flag.
 */
export function __getSharedClientForTesting(): Redis | null {
  return sharedClient;
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
  // can't leave the module in a partial-cleanup state — e.g. cachedQueues=null
  // but sharedClient still set, where the NEXT closeQueues() call would
  // skip the queues block (already null) and hit the warning branch,
  // leaking the shared client forever. The try/finally guarantees both
  // fields are nulled even if Queue.close() throws.
  //
  // We use `disconnect()` (synchronous, forceful) on the shared client
  // rather than `quit()` (async, polite). Two reasons:
  //   1. ioredis does not reliably update its `status` field to 'end'
  //      after an awaited `quit()` in all scenarios — BullMQ itself
  //      documents and works around this in its own RedisConnection.close
  //      via a manual `this._client['status'] = 'end'` assignment.
  //      Using disconnect avoids the reliability gap entirely.
  //   2. At SIGTERM time the distinction between polite QUIT and abrupt
  //      socket close is operationally meaningless — Redis treats both
  //      as connection closures. We are tearing the worker down either
  //      way; deterministic > polite.
  try {
    if (cachedQueues !== null) {
      await Promise.all([
        cachedQueues.outboxDrain.close(),
        cachedQueues.attributionCompute.close(),
      ]);
    }
    if (sharedClient !== null) {
      // ioredis's `disconnect()` severs the socket synchronously, but
      // the resulting status transition to 'end' propagates through the
      // Node.js event loop (socket close event → ioredis close handler →
      // status update). Without awaiting the 'end' event, closeQueues
      // returns before the connection is observably torn down, which
      // breaks any caller that checks the client's status post-shutdown
      // (notably the step-5 integration test honoring Checkpoint 4).
      //
      // Capture the reference into a local because the `finally` block
      // below nulls `sharedClient` after this try-block exits — but the
      // local survives, so the `once('end')` listener attaches to the
      // right instance.
      const client = sharedClient;
      const endPromise = new Promise<void>((resolve) => {
        client.once('end', () => resolve());
      });
      client.disconnect();
      await endPromise;
    }
  } finally {
    cachedQueues = null;
    sharedClient = null;
  }
}
