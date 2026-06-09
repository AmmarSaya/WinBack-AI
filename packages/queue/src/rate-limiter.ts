/**
 * A2 / POST-EPIC-F §2 — per-merchant hourly AI generation rate limiter.
 *
 * Atomic INCR-with-TTL via a cached Lua script. Used by
 * `handleCustomerStateChanged` BEFORE the §F-9 spend-cap check to
 * cheaply deny over-burst generations before any DB write.
 *
 * Why Lua over INCR + EXPIRE in two client calls:
 *   A client crash between `INCR` and `EXPIRE` leaves a TTL-less key
 *   that NEVER expires. That merchant is then permanently rate-limited
 *   at whatever count the key reached until manual `DEL`. Not just a
 *   memory leak — a correctness bug visible as "merchant X is forever
 *   capped." Lua execution is atomic from Redis's perspective (a server
 *   crash mid-script is the only failure mode and it discards the
 *   partial state, exactly the property we want).
 *
 * Caching:
 *   SCRIPT LOAD on first use, SHA cached, EVALSHA per subsequent call.
 *   NOSCRIPT (script evicted by Redis FLUSH / restart / replication
 *   catch-up) → re-load and retry the call ONCE. A second NOSCRIPT
 *   would indicate a misconfigured Redis and is escalated.
 *
 * Window semantics: UTC fixed hour bucket.
 *   bucket = Math.floor(Date.now() / 3_600_000)
 *   key    = `ai:gen:rate:<merchantId>:<bucket>`
 *   TTL    = 3600s (set on first INCR; cleared at hour-rollover by
 *            either the TTL or the new-key-is-fresh path)
 *
 * Trade-off (POST-EPIC-F §2 lock): boundary 2× burst is accepted —
 * `100` at 12:59 + `100` at 13:00 = 200 within 2 minutes, both passing
 * because they hit different bucket keys. §2 explicitly takes this as
 * the simplicity tradeoff vs sliding-window / token-bucket complexity.
 *
 * Counting semantics: the count IS incremented on EVERY call, including
 * over-cap calls (the post-INCR comparison decides `allowed`, not a
 * pre-INCR check). This is intentional — over-cap calls land in the
 * counter so a flooding merchant's actual transition-event volume is
 * visible in Redis observability, not just the first 100 of every hour.
 */

import { type Redis } from 'ioredis';

import { getQueueLayerClient } from './queues.js';

/**
 * Lua script: INCR a key + EXPIRE on the FIRST increment only.
 *
 * KEYS[1] = the rate-limit key (`ai:gen:rate:<merchantId>:<bucket>`)
 * ARGV[1] = TTL in seconds (stringified — Lua receives numerics as
 *            strings; redis.call coerces)
 *
 * Returns: integer — the post-increment count.
 *
 * `count == 1` ⇒ this call CREATED the key (it didn't exist before).
 * On every subsequent INCR the key already has a TTL from creation,
 * so re-applying EXPIRE would be wasted work AND would extend the
 * window on every hit — incorrect semantics for a fixed-hour bucket.
 * The `if count == 1` gate is load-bearing for window correctness, not
 * just an optimisation.
 */
const INCR_WITH_TTL_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`.trim();

const HOUR_TTL_SECONDS = 3600;
const HOUR_BUCKET_MS = 3_600_000;

let cachedScriptSha: string | null = null;

async function loadScript(client: Redis): Promise<string> {
  // ioredis types `script` loosely; cast the load result to string.
  const sha = (await client.script('LOAD', INCR_WITH_TTL_LUA)) as string;
  cachedScriptSha = sha;
  return sha;
}

/**
 * Run the cached script via EVALSHA. Handles NOSCRIPT by re-loading
 * and retrying ONCE. A second NOSCRIPT propagates as an error — at
 * that point Redis is misbehaving (likely SCRIPT FLUSH between our
 * load and our retry), and the caller should see it.
 */
async function evalIncrWithTtl(client: Redis, key: string): Promise<number> {
  cachedScriptSha ??= await loadScript(client);
  try {
    return (await client.evalsha(
      cachedScriptSha,
      1,
      key,
      String(HOUR_TTL_SECONDS),
    )) as number;
  } catch (err) {
    if (err instanceof Error && err.message.includes('NOSCRIPT')) {
      cachedScriptSha = await loadScript(client);
      return (await client.evalsha(
        cachedScriptSha,
        1,
        key,
        String(HOUR_TTL_SECONDS),
      )) as number;
    }
    throw err;
  }
}

export interface IncrementAndCheckResult {
  readonly allowed: boolean;
  readonly currentCount: number;
}

/**
 * Atomically increment the per-merchant hourly counter and return
 * whether the post-increment count is within the cap.
 *
 * @param merchantId  Internal merchant cuid (NOT a Shopify GID).
 * @param capPerHour  The cap from `MerchantSettings.hourlyGenerationCap`.
 * @param client      Optional ioredis client override (test seam — production
 *                    uses the shared queue-layer client via
 *                    `getQueueLayerClient`).
 *
 * Behavior:
 *   - `allowed === true`  → post-increment count ≤ capPerHour.
 *   - `allowed === false` → post-increment count > capPerHour. Caller
 *     must NOT proceed with generation; emit `ai.rate_limited` audit.
 *
 * Idempotency / atomicity:
 *   - The INCR is atomic per Redis single-threaded execution; concurrent
 *     calls from multiple handler invocations cannot double-count.
 *   - The TTL is set atomically with the first INCR via the Lua script
 *     (see `INCR_WITH_TTL_LUA` docstring).
 *
 * Side effect: ALL calls (including over-cap) increment the counter.
 * See module header "Counting semantics" for the rationale.
 */
export async function incrementAndCheck(
  merchantId: string,
  capPerHour: number,
  client?: Redis,
): Promise<IncrementAndCheckResult> {
  const conn = client ?? getQueueLayerClient();
  const bucket = Math.floor(Date.now() / HOUR_BUCKET_MS);
  const key = `ai:gen:rate:${merchantId}:${bucket.toString()}`;
  const currentCount = await evalIncrWithTtl(conn, key);
  return {
    allowed: currentCount <= capPerHour,
    currentCount,
  };
}

/**
 * INTERNAL — exposed for tests that need to invalidate the cached SHA
 * (e.g. simulate NOSCRIPT eviction). NOT re-exported from `index.ts`.
 * Production code MUST NOT call this.
 */
export function _resetScriptCacheForTesting(): void {
  cachedScriptSha = null;
}

/**
 * INTERNAL — exposed for tests so they can compute the same hour bucket
 * the production call uses and pre-seed Redis directly. NOT re-exported.
 */
export function _hourBucketForTesting(nowMs: number): number {
  return Math.floor(nowMs / HOUR_BUCKET_MS);
}
