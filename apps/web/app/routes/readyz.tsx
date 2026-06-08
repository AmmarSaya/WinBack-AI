import { getRedisConfig } from '@winback/config';
import { SYSTEM_SCOPE_REASONS } from '@winback/contracts';
import { withSystemScope } from '@winback/db';
import { getLogger } from '@winback/logger';
import { Redis, type RedisOptions } from 'ioredis';

import { getPrisma } from '~/services/db.server.js';

const log = getLogger('web.readyz');

/**
 * Readiness probe — extended in B5.
 *
 * Three-layer separation between liveness, readiness, and operator alerts:
 *
 *   - /healthz  → pure process-liveness ping. No I/O. Untouched in B5.
 *   - /readyz   → this route. Returns 503 ONLY when a hard dependency
 *                 (Postgres / Redis) is unreachable or its canary times
 *                 out. 503 means "do not route traffic to this container"
 *                 — reserved exclusively for routing decisions the load
 *                 balancer should act on.
 *   - Operator-alert signals (DLQ depth, outbox stall age) ride along in
 *     the 200 response body's `warnings[]` array. These are NEVER 503 —
 *     a backlogged DLQ does not mean "stop routing", it means "page an
 *     operator". Even at the CRITICAL threshold we return 200; the
 *     escalation lives in the warning text, not the HTTP status.
 *
 * Threshold constants are declared at module top with one-line rationale.
 * Not env-tunable in B5 — the "transient vs systematic" cutoffs are
 * operational conventions, not per-deploy knobs.
 *
 * Timeout split (added with the (a-strict) Redis-access refactor):
 *   - Postgres SELECT 1 canary OR Redis PING timing out → 503. A check
 *     that hangs is worse than one that fails; a hung probe could make
 *     Render mark the service unresponsive AND consume request slots.
 *   - DLQ count or stall MIN query timing out → 200 with `warnings[]`,
 *     NOT 503. Postgres is REACHABLE (the SELECT 1 canary already passed
 *     in that case); the operator-signal query was merely slow. Treating
 *     that as a routing-out signal would conflate "database slow" with
 *     "database down" — the conflation we explicitly designed out.
 *
 * Implementation notes:
 *   - Postgres SELECT 1 and the OutboxEvent reads run inside
 *     `withSystemScope(SYSTEM_SCOPE_REASONS.healthcheck.readyz)` because
 *     /readyz has no tenant context — the Prisma extension would reject
 *     the queries otherwise.
 *   - The stall-age query's WHERE clause MUST EXACTLY match the partial
 *     index predicate from migration `20260516130100_add_outbox_claimable_idx`
 *     so the planner uses the partial index instead of a seq-scan.
 *   - Redis PING uses a MODULE-SCOPE memoized ioredis client. A long-lived
 *     web process polls /readyz on a cadence (Render uptime check + the
 *     Render dashboard probe); constructing a fresh client per poll churns
 *     connections needlessly. The client is reset between tests via
 *     `_resetReadyzRedisForTests`.
 */

// Below this row count, dead-lettered events are transient/routine —
// occasional non-retryable failures, expected operationally. Above this,
// page an operator: something systematic is failing.
const DLQ_WARN_THRESHOLD = 5;
// Above this row count, the DLQ is no longer "a few stragglers" — it is
// a backlog deep enough to imply a broken handler or a poisoned-payload
// pattern. The warning is escalated to "critical" but still rides in the
// 200 body (operator alert, not a routing signal).
const DLQ_CRITICAL_THRESHOLD = 50;
// Below this stall age in seconds, the oldest unprocessed row is
// transient/routine — the drainer's normal poll loop and a momentary
// burst can produce stalls of this magnitude. Above this, the drainer
// is likely stuck or starved.
const STALL_WARN_SECONDS = 300; // 5 minutes
// Above this stall age in seconds, the drainer has been effectively
// down for long enough that downstream SLAs (webhook ack windows, send
// pipeline latency) are at risk. Escalated to "critical" but still
// returns 200 — this is an operator-alert signal, not a routing signal.
const STALL_CRITICAL_SECONDS = 900; // 15 minutes

// Per-I/O timeout. A probe must not hang. 2s is generous for a SELECT 1
// or a PING under healthy conditions and tight enough that a hung
// dependency degrades the probe within a single Render uptime poll.
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Why we DELIBERATELY OMIT `maxRetriesPerRequest: null` and
 * `enableReadyCheck: false` here even though `packages/queue/src/redis-client.ts`
 * sets them:
 *
 * Those two flags are BullMQ Worker requirements. `maxRetriesPerRequest: null`
 * disables ioredis's finite per-request retry counter because BullMQ's
 * blocking commands need infinite retry semantics; `enableReadyCheck: false`
 * suppresses ioredis's own PING-during-connect because BullMQ has its own
 * equivalent. Neither matters for a one-shot /readyz PING:
 *   - Retry policy doesn't affect a single PING result. If the connect
 *     fails or the command times out under our race, we report unhealthy.
 *   - ioredis's PING-during-connect ready check is harmlessly duplicative
 *     of our PING (and arguably useful — it confirms the connection works
 *     before we send ours).
 *
 * The SAME-CONFIG guarantee for /readyz reduces to URL + TLS — those are
 * the fields that determine whether we can REACH Redis, which is what the
 * probe tests. URL and TLS-cert-validation both come from
 * `getRedisConfig()`, the same source `createRedisClient` uses in
 * production. The BullMQ-flag-class options govern post-connect behavior
 * irrelevant to PING-result correctness.
 *
 * Do NOT add `maxRetriesPerRequest: null` / `enableReadyCheck: false`
 * back here "for parity with createRedisClient" — they would not change
 * probe behavior, but they would imply this client is meant to behave like
 * a BullMQ Worker connection, which it is not. If a future option DOES
 * affect reachability (e.g. `family: 6`, `connectTimeout`), it should be
 * added to BOTH this construction site AND `createRedisClient` and locked
 * with the registry-shape-test pattern.
 */
function buildReadyzRedisOptions(): RedisOptions {
  const config = getRedisConfig();
  const isTls = config.REDIS_URL.startsWith('rediss://');
  const options: RedisOptions = {
    connectionName: 'readyz.ping',
  };
  if (isTls) {
    options.tls = {
      rejectUnauthorized: config.REDIS_TLS_REJECT_UNAUTHORIZED,
    };
  }
  return options;
}

let cachedRedis: Redis | null = null;

function getReadyzRedisClient(): Redis {
  if (cachedRedis === null) {
    const config = getRedisConfig();
    cachedRedis = new Redis(config.REDIS_URL, buildReadyzRedisOptions());
  }
  return cachedRedis;
}

/** Test seam. Disconnects the memoized client so a fresh mock can take effect. */
export function _resetReadyzRedisForTests(): void {
  if (cachedRedis !== null) {
    cachedRedis.disconnect();
    cachedRedis = null;
  }
}

/**
 * Wrap a promise in a race against a timer. The timer is cleared in
 * either outcome to avoid leaking a pending setTimeout when the probe
 * resolves quickly. The error message carries the label so the resulting
 * `errors[]` / `warnings[]` entry identifies which I/O timed out.
 */
async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${String(timeoutMs)}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Shape of the `checks` object — exposed for both ok and unhealthy responses. */
interface ReadyzChecks {
  postgres: 'ok' | 'fail';
  redis: 'ok' | 'fail';
  outboxDlq: number;
  stallAgeSeconds: number;
}

type ReadyzBody =
  | {
      status: 'ok';
      checks: ReadyzChecks;
      warnings?: string[];
    }
  | {
      status: 'unhealthy';
      checks: ReadyzChecks;
      errors: string[];
    };

export async function loader() {
  let postgresOk = false;
  let redisOk = false;
  let outboxDlq = 0;
  let stallAgeSeconds = 0;
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- Postgres + outbox metrics (tenant-scoped resource) --------------
  // SELECT 1 is the canary — its failure (or timeout) is the ONLY
  // Postgres signal that produces 503. The DLQ + stall queries run AFTER
  // SELECT 1 succeeds; they have their own inner try/catch so a slow or
  // failing operator-signal query degrades to a warning, not a routing
  // signal. This split is the "DB slow ≠ DB down" rule.
  try {
    await withSystemScope(SYSTEM_SCOPE_REASONS.healthcheck.readyz, async () => {
      const prisma = getPrisma();

      // Canary. Failure or timeout cascades to the outer catch → 503.
      await raceWithTimeout(
        prisma.$queryRaw`SELECT 1`,
        PROBE_TIMEOUT_MS,
        'postgres SELECT 1',
      );
      // Mark postgres ok BEFORE running the operator-signal queries.
      // After this point, an exception from DLQ/stall handling does NOT
      // unset postgresOk — it is caught locally and surfaces as a warning.
      postgresOk = true;

      // DLQ depth. Failure or timeout → warning, NOT 503.
      try {
        const dlqRows = await raceWithTimeout(
          prisma.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(*)::bigint AS count
            FROM "OutboxEvent"
            WHERE "deadLetteredAt" IS NOT NULL
          `,
          PROBE_TIMEOUT_MS,
          'postgres DLQ count',
        );
        outboxDlq = Number(dlqRows[0]?.count ?? 0n);
      } catch (err) {
        log.warn(
          { err },
          'readiness probe: DLQ depth query failed (postgres reachable; operator-signal degraded)',
        );
        warnings.push(`outbox_dlq: probe query failed — ${errMessage(err)}`);
      }

      // Oldest unprocessed event age. WHERE clause MUST EXACTLY match the
      // partial index predicate from `20260516130100_add_outbox_claimable_idx`
      // so the planner uses the partial index. Predicate:
      //   WHERE "processedAt" IS NULL AND "deadLetteredAt" IS NULL
      // Failure or timeout → warning, NOT 503 (same reasoning as DLQ).
      try {
        const stallRows = await raceWithTimeout(
          prisma.$queryRaw<{ oldest: Date | null }[]>`
            SELECT MIN("createdAt") AS oldest
            FROM "OutboxEvent"
            WHERE "processedAt" IS NULL AND "deadLetteredAt" IS NULL
          `,
          PROBE_TIMEOUT_MS,
          'postgres stall MIN',
        );
        const oldestUnprocessedCreatedAt = stallRows[0]?.oldest ?? null;
        if (oldestUnprocessedCreatedAt === null) {
          stallAgeSeconds = 0;
        } else {
          const nowMs = Date.now();
          const oldestMs = oldestUnprocessedCreatedAt.getTime();
          stallAgeSeconds = Math.max(0, Math.floor((nowMs - oldestMs) / 1000));
        }
      } catch (err) {
        log.warn(
          { err },
          'readiness probe: stall MIN query failed (postgres reachable; operator-signal degraded)',
        );
        warnings.push(`outbox_stall: probe query failed — ${errMessage(err)}`);
      }
    });
  } catch (err) {
    log.error({ err }, 'readiness probe: postgres canary failed');
    errors.push(`postgres: ${errMessage(err)}`);
  }

  // --- Redis PING (not tenant-scoped) ----------------------------------
  // Module-scope memoized client. .ping() per poll, no connect/quit churn.
  // Failure or timeout → 503. Same reachability semantics as Postgres
  // SELECT 1.
  try {
    const redisClient = getReadyzRedisClient();
    await raceWithTimeout(
      redisClient.ping(),
      PROBE_TIMEOUT_MS,
      'redis PING',
    );
    redisOk = true;
  } catch (err) {
    log.error({ err }, 'readiness probe: redis check failed');
    errors.push(`redis: ${errMessage(err)}`);
  }

  const checks: ReadyzChecks = {
    postgres: postgresOk ? 'ok' : 'fail',
    redis: redisOk ? 'ok' : 'fail',
    outboxDlq,
    stallAgeSeconds,
  };

  // --- 503: routing signal --------------------------------------------
  // Per locked decision #1: 503 is reserved EXCLUSIVELY for the load
  // balancer ("don't route traffic"). The only triggers are hard
  // dependency failures (Postgres SELECT 1 throws/times out OR Redis
  // PING throws/times out). DLQ depth, stall age, and the operator-
  // signal query timeouts never produce 503.
  if (!postgresOk || !redisOk) {
    const body: ReadyzBody = {
      status: 'unhealthy',
      checks,
      errors,
    };
    return new Response(JSON.stringify(body), {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  }

  // --- 200 with operator-alert warnings -------------------------------
  // Per locked decision #2: DLQ depth and stall age are operator-alert
  // signals, NEVER routing signals. Even at CRITICAL thresholds we
  // return 200 — the escalation lives in the warning text. Same applies
  // to operator-signal query timeouts already pushed above.
  if (outboxDlq > DLQ_CRITICAL_THRESHOLD) {
    warnings.push(
      `outbox_dlq: critical — ${String(outboxDlq)} rows dead-lettered (threshold ${String(DLQ_CRITICAL_THRESHOLD)})`,
    );
  } else if (outboxDlq > DLQ_WARN_THRESHOLD) {
    warnings.push(`outbox_dlq: ${String(outboxDlq)} rows dead-lettered`);
  }

  if (stallAgeSeconds > STALL_CRITICAL_SECONDS) {
    warnings.push(
      `outbox_stall: critical — oldest unprocessed event ${String(stallAgeSeconds)} seconds old (threshold ${String(STALL_CRITICAL_SECONDS)})`,
    );
  } else if (stallAgeSeconds > STALL_WARN_SECONDS) {
    warnings.push(
      `outbox_stall: oldest unprocessed event ${String(stallAgeSeconds)} seconds old`,
    );
  }

  const body: ReadyzBody =
    warnings.length > 0
      ? { status: 'ok', checks, warnings }
      : { status: 'ok', checks };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
