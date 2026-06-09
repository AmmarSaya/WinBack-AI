import { QUEUE_NAMES } from '@winback/contracts';
import { Queue, type QueueOptions } from 'bullmq';
import type { Redis } from 'ioredis';

import { createRedisClient } from './redis-client.js';
import type { Queues } from './types.js';

/**
 * Memory-bounded Queue options applied to every Queue in the registry.
 *
 * Surfaced 2026-05-23 after Render Key Value's 25MB tier hit OOM during
 * a routine drainer restart cycle — BullMQ's defaults are tuned for
 * production-scale Redis (no memory ceiling assumption), and a tiny dev
 * Redis tier filled within ~24h of idle polling.
 *
 *   - `streams.events.maxLen: 1000` — caps the per-Queue `<queue>:events`
 *     XADD stream length. BullMQ default is 10000. Across 3 queues +
 *     idle-poll noise, that defaulted to ~7-8MB of stream entries which
 *     dominated the 25MB tier. 1000 keeps recent observability while
 *     bounding memory at ~1MB across the three queues combined.
 *
 *   - `defaultJobOptions.removeOnComplete: true` — every job in this
 *     registry is a scheduling tick (`outbox.drain`, `cron.rollup`,
 *     `cron.sweep`). Their payloads are pure plumbing (`{ enqueuedAt }`
 *     or `{}`), so retaining completed-job hashes after the tick fires
 *     buys nothing — operator observability lives in the WebhookLog /
 *     OutboxEvent rows in Postgres, not in BullMQ. Delete immediately.
 *
 *   - `defaultJobOptions.removeOnFail: { count: 1000 }` — failures keep
 *     the last 1000 per queue for forensic debugging, older evicted
 *     oldest-first. Bounded retention. M10 follow-up may add `age`
 *     ceiling once production scale gives us a real number for "how
 *     long is forensically useful."
 *
 * Any per-`queue.add()` job options will OVERRIDE these defaults — the
 * four call sites in apps/drainer/src/scheduling.ts and
 * apps/scheduler/src/scheduling.ts were audited and none set
 * removeOnComplete/removeOnFail, so the defaults apply uniformly.
 * Repeatable jobs (cron.rollup pattern, cron.sweep every) are unaffected
 * by these options — the repeat scheduler key is stored separately and
 * not subject to job-instance lifecycle.
 */
const SHARED_QUEUE_OPTIONS: Omit<QueueOptions, 'connection'> = {
  streams: { events: { maxLen: 1000 } },
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: { count: 1000 },
  },
};

/**
 * BullMQ queue registry — gives consumers typed Queue handles for every
 * named queue in `QUEUE_NAMES`.
 *
 * Queues today: `outbox.drain` (D2) + `cron.rollup` / `cron.sweep` (D3).
 * `attribution.compute` was removed in the C1 fix — CP-2 §Q1 specifies
 * inline drainer work for attribution, not a separate queue + consumer.
 * Every Queue here shares ONE
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

/**
 * Lazy-init the shared queue-layer ioredis client. Internal helper used
 * by both `getQueues()` and `getQueueLayerClient()` so the shared client
 * has ONE construction path and ONE lifecycle (closed by `closeQueues()`).
 */
function ensureSharedClient(): Redis {
  sharedClient ??= createRedisClient('queues.shared');
  return sharedClient;
}

export function getQueues(): Queues {
  if (cachedQueues === null) {
    const conn = ensureSharedClient();
    cachedQueues = {
      outboxDrain: new Queue(QUEUE_NAMES.outbox.drain, {
        connection: conn,
        ...SHARED_QUEUE_OPTIONS,
      }),
      cronRollup: new Queue(QUEUE_NAMES.cron.rollup, {
        connection: conn,
        ...SHARED_QUEUE_OPTIONS,
      }),
      cronSweep: new Queue(QUEUE_NAMES.cron.sweep, {
        connection: conn,
        ...SHARED_QUEUE_OPTIONS,
      }),
      aiGenerate: new Queue(QUEUE_NAMES.ai.generate, {
        connection: conn,
        ...SHARED_QUEUE_OPTIONS,
      }),
    };
  }
  return cachedQueues;
}

/**
 * Returns the shared queue-layer ioredis client for NON-BLOCKING command
 * consumers that logically live in the queue layer (A2 rate-limiter is
 * the first caller — `INCR` + `EVALSHA` are both non-blocking, safe to
 * multiplex on `queues.shared`).
 *
 * Sharing rule (per `redis-client.ts` header):
 *   - SAFE to share with this connection: any non-blocking command
 *     (INCR, GET, SET, EVAL, EVALSHA on non-blocking scripts, etc.).
 *     BullMQ Queue producers (already sharing) and rate-limiter use
 *     non-blocking only.
 *   - DO NOT share with this connection: BullMQ Workers (BLPOP/BRPOPLPUSH
 *     blocking commands), or anything that holds a connection-pinned
 *     subscription. Those get their own `createRedisClient(...)`.
 *
 * Lifecycle is identical to `getQueues()`: lazy-init on first call,
 * memoized to the same `sharedClient`, closed by `closeQueues()`. A
 * caller using ONLY `getQueueLayerClient()` (no `getQueues()`) still
 * needs `closeQueues()` to tear down at shutdown.
 */
export function getQueueLayerClient(): Redis {
  return ensureSharedClient();
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
        cachedQueues.cronRollup.close(),
        cachedQueues.cronSweep.close(),
        cachedQueues.aiGenerate.close(),
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
        client.once('end', () => { resolve(); });
      });
      client.disconnect();
      await endPromise;
    }
  } finally {
    cachedQueues = null;
    sharedClient = null;
  }
}
