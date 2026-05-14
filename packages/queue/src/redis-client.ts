import { getRedisConfig } from '@winback/config';
import { Redis, type RedisOptions } from 'ioredis';

/**
 * Creates a fresh ioredis client for the workspace's Redis target.
 *
 * Why a factory (not a singleton):
 *   - BullMQ Workers (D2+) require DEDICATED connections — blocking
 *     commands (BRPOPLPUSH and similar) stall everything else on a
 *     shared client. A factory makes this explicit: every Worker asks
 *     for its own client at construction.
 *   - The future cache layer has a different operational profile from
 *     BullMQ; it gets its own connection, isolated from queue traffic.
 *
 * The sharing rule: SHARE WITHIN A CONSUMER CLASS, NOT ACROSS CLASSES.
 *   - All BullMQ Queue instances may share one client (Queue uses
 *     non-blocking commands only). `getQueues()` in this package does
 *     exactly that — one `'queues.shared'` connection for both Queues
 *     today, scaling to all future Queue instances.
 *   - Each BullMQ Worker gets its own dedicated client. D2 will call
 *     this factory with the Worker's name (e.g. `'worker.outbox-drain'`).
 *   - Cache layer (post-MVP) gets its own client (e.g. `'cache'`).
 *
 * `connectionName` is set on the ioredis instance so the connection is
 * identifiable in Redis's `CLIENT LIST` output for operational
 * monitoring. Pick a descriptive name when calling this — it surfaces
 * in production tooling and helps diagnose connection storms by
 * subsystem.
 *
 * BullMQ-required ioredis options are applied unconditionally — every
 * client this factory produces is BullMQ-safe even if the caller is a
 * non-BullMQ consumer (e.g. a future cache layer). The cost (a slightly
 * different retry profile) is trivial; the alternative (per-consumer
 * option sets) would duplicate BullMQ knowledge across call sites.
 *
 * Implication callers MUST know: `maxRetriesPerRequest: null` disables
 * ioredis's built-in command-retry logic entirely. A transient Redis
 * blip produces an immediate error rather than a retried command. This
 * is correct for BullMQ (which manages its own retry semantics on top
 * of jobs), but wrong for use cases that want command-level retry —
 * notably a future cache layer. Callers that need automatic retry
 * behavior should create their own ioredis client with different
 * options rather than using this factory.
 *
 * TLS is auto-enabled when REDIS_URL uses the `rediss://` scheme. The
 * `rejectUnauthorized` flag is driven by `getRedisConfig`, which refuses
 * `REDIS_TLS_REJECT_UNAUTHORIZED=false` in production at boot. That
 * upstream check is the production-policy gate; we do not duplicate it
 * here.
 */
export function createRedisClient(connectionName: string): Redis {
  const config = getRedisConfig();
  const isTls = config.REDIS_URL.startsWith('rediss://');

  const options: RedisOptions = {
    connectionName,
    // BullMQ hard requirement — finite retry counts break the Worker.
    // See: https://docs.bullmq.io/guide/connections
    maxRetriesPerRequest: null,
    // BullMQ recommendation — disables ioredis's PING-based ready check.
    // BullMQ has its own equivalent check internally.
    enableReadyCheck: false,
  };

  if (isTls) {
    options.tls = {
      rejectUnauthorized: config.REDIS_TLS_REJECT_UNAUTHORIZED,
    };
  }

  return new Redis(config.REDIS_URL, options);
}
