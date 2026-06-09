/**
 * A2 / POST-EPIC-F §2 — rate-limiter integration tests (real Redis).
 *
 * Exercises the atomicity + Lua + EVALSHA caching paths against the
 * Docker Redis container booted by `pnpm queue:test`. Validates the
 * load-bearing properties that mocked Redis cannot:
 *   1. Single-call increment + cap comparison correctness.
 *   2. Concurrent INCR atomicity (no double-count under parallel load).
 *   3. TTL is set atomically with the first INCR.
 *   4. TTL is NOT extended on subsequent INCRs (window correctness).
 *   5. NOSCRIPT recovery (SCRIPT FLUSH between loads → reload + retry).
 *   6. Multi-merchant key isolation (caps are per-merchant-per-hour).
 *   7. Hour-bucket rollover boundary (key changes at top-of-hour UTC).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeQueues, getQueueLayerClient } from '../../src/queues.js';
import {
  _hourBucketForTesting,
  _resetScriptCacheForTesting,
  incrementAndCheck,
} from '../../src/rate-limiter.js';

import { getTestRedisClient, resetRedis, teardown } from './setup.js';

beforeEach(async () => {
  // Silence the documented double-close warning from closeQueues —
  // matches the queue-integration.test.ts hygiene.
  // eslint-disable-next-line @typescript-eslint/no-empty-function -- Intentional no-op to silence the documented double-close warning; empty body IS the silenced output.
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  await closeQueues();
  await resetRedis();
  // Invalidate the cached SHA so each test starts from a fresh SCRIPT
  // LOAD, exercising the first-call-loads-script branch.
  _resetScriptCacheForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await teardown();
});

describe('rate-limiter — integration (real Redis)', () => {
  it('1. under cap → allowed=true; count increments per call', async () => {
    const cap = 5;
    const merchantId = 'm_under_cap';

    const results = [];
    for (let i = 0; i < 3; i += 1) {
      results.push(await incrementAndCheck(merchantId, cap));
    }

    expect(results[0]).toEqual({ allowed: true, currentCount: 1 });
    expect(results[1]).toEqual({ allowed: true, currentCount: 2 });
    expect(results[2]).toEqual({ allowed: true, currentCount: 3 });
  });

  it('2. at cap exactly → allowed=true; cap+1 → allowed=false', async () => {
    const cap = 3;
    const merchantId = 'm_at_cap';

    // First 3 calls should be allowed (1, 2, 3 — each ≤ cap).
    for (let i = 0; i < cap; i += 1) {
      const r = await incrementAndCheck(merchantId, cap);
      expect(r.allowed).toBe(true);
      expect(r.currentCount).toBe(i + 1);
    }

    // The 4th call: post-increment count = 4 > cap=3 → not allowed.
    const overCap = await incrementAndCheck(merchantId, cap);
    expect(overCap.allowed).toBe(false);
    expect(overCap.currentCount).toBe(4);

    // Further over-cap calls keep incrementing (counting observed
    // demand, per the module's "Counting semantics" docstring).
    const stillOver = await incrementAndCheck(merchantId, cap);
    expect(stillOver.allowed).toBe(false);
    expect(stillOver.currentCount).toBe(5);
  });

  it('3. concurrent calls are atomic — 50 parallel INCRs produce exactly 50 count, no double-count', async () => {
    const cap = 100;
    const merchantId = 'm_concurrent';
    const parallelism = 50;

    const results = await Promise.all(
      Array.from({ length: parallelism }, () =>
        incrementAndCheck(merchantId, cap),
      ),
    );

    // The post-increment counts returned must cover 1..parallelism
    // exactly once each — no value missing, no value duplicated. If
    // INCR were not atomic, two callers could see the same count.
    const counts = results.map((r) => r.currentCount).sort((a, b) => a - b);
    expect(counts).toEqual(
      Array.from({ length: parallelism }, (_, i) => i + 1),
    );

    // All 50 calls were under cap (50 ≤ 100), so all returned allowed.
    expect(results.every((r) => r.allowed)).toBe(true);
  });

  it('4. TTL is set atomically with the first INCR (key has TTL between 1 and 3600 seconds)', async () => {
    const merchantId = 'm_ttl_first';
    await incrementAndCheck(merchantId, 100);

    const admin = getTestRedisClient();
    const bucket = _hourBucketForTesting(Date.now());
    const key = `ai:gen:rate:${merchantId}:${bucket.toString()}`;
    const ttl = await admin.ttl(key);

    // TTL > 0 means a TTL is set. The Lua script sets it to 3600 on
    // first INCR; we tolerate up to ~1s of drift between script
    // execution and our TTL probe.
    expect(ttl).toBeGreaterThan(3590);
    expect(ttl).toBeLessThanOrEqual(3600);
  });

  it('5. subsequent INCRs do NOT extend the TTL (window correctness — the conditional EXPIRE)', async () => {
    const merchantId = 'm_ttl_no_extend';
    const admin = getTestRedisClient();
    const bucket = _hourBucketForTesting(Date.now());
    const key = `ai:gen:rate:${merchantId}:${bucket.toString()}`;

    // First call sets TTL = 3600.
    await incrementAndCheck(merchantId, 100);

    // Forcibly shorten the TTL so we can detect a wrongful extend on
    // the next call. A correct implementation calls EXPIRE only on the
    // FIRST INCR (count==1), so the second call must NOT bump the TTL.
    await admin.expire(key, 60);
    const ttlBefore = await admin.ttl(key);
    expect(ttlBefore).toBeLessThanOrEqual(60);

    // Second call.
    await incrementAndCheck(merchantId, 100);

    // TTL must NOT have been extended back to 3600. If the Lua script
    // were unconditional-EXPIRE, this would fail.
    const ttlAfter = await admin.ttl(key);
    expect(ttlAfter).toBeLessThanOrEqual(60);
  });

  it('6. NOSCRIPT recovery — SCRIPT FLUSH between calls → next call re-loads + succeeds', async () => {
    const merchantId = 'm_noscript';

    // First call loads + caches the script.
    const before = await incrementAndCheck(merchantId, 100);
    expect(before.currentCount).toBe(1);

    // Forcibly evict ALL cached scripts from the Redis server. The
    // module's cached SHA is now stale.
    const admin = getTestRedisClient();
    await admin.script('FLUSH');

    // Next call: EVALSHA returns NOSCRIPT → module catches it, calls
    // SCRIPT LOAD again, retries EVALSHA, succeeds. No exception
    // surfaces to the caller.
    const after = await incrementAndCheck(merchantId, 100);
    expect(after.currentCount).toBe(2);
    expect(after.allowed).toBe(true);
  });

  it('7. multi-merchant key isolation — separate merchants have separate counters', async () => {
    const cap = 10;
    const a = 'm_isolation_a';
    const b = 'm_isolation_b';

    // Fire 3 for A, 5 for B. The post-increment counts must reflect
    // each merchant's INDEPENDENT history, not a shared counter.
    for (let i = 0; i < 3; i += 1) {
      await incrementAndCheck(a, cap);
    }
    for (let i = 0; i < 5; i += 1) {
      await incrementAndCheck(b, cap);
    }

    const aNext = await incrementAndCheck(a, cap);
    const bNext = await incrementAndCheck(b, cap);

    expect(aNext.currentCount).toBe(4);
    expect(bNext.currentCount).toBe(6);
  });

  it('8. hour-bucket rollover — advancing past top-of-hour starts a new key at count=1', async () => {
    const merchantId = 'm_rollover';
    const cap = 100;

    // Pin "now" inside an hour. 2026-06-10T10:30:00Z is mid-hour H.
    const insideHourH = new Date('2026-06-10T10:30:00Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(insideHourH);

    const inH = await incrementAndCheck(merchantId, cap);
    expect(inH.currentCount).toBe(1);

    // Advance system time past the hour boundary (10:59 → 11:00). The
    // new call computes a DIFFERENT bucket (Math.floor(now / 3_600_000)),
    // hits a fresh key, returns count = 1 — proving the fixed-window
    // resets at the top-of-hour UTC boundary, not via key expiration.
    const insideHourHPlus1 = new Date('2026-06-10T11:00:00Z').getTime();
    vi.setSystemTime(insideHourHPlus1);

    const inHPlus1 = await incrementAndCheck(merchantId, cap);
    expect(inHPlus1.currentCount).toBe(1);

    // Sanity: the two calls landed on different bucket keys.
    expect(_hourBucketForTesting(insideHourH)).not.toBe(
      _hourBucketForTesting(insideHourHPlus1),
    );

    vi.useRealTimers();
  });

  // Defensive smoke test: getQueueLayerClient returns a working client
  // that can issue our INCR. This is the production code path the
  // handler hits (no explicit `client` arg → falls through to
  // getQueueLayerClient internally).
  it('9. production client path — getQueueLayerClient supplies a working ioredis instance', async () => {
    const client = getQueueLayerClient();
    expect(client).toBeDefined();
    // PING is also non-blocking; safe to issue on the shared client.
    const pong = await client.ping();
    expect(pong).toBe('PONG');

    // Confirm the rate-limiter without explicit client falls through
    // to this same shared client and works end-to-end.
    const r = await incrementAndCheck('m_prod_path', 100);
    expect(r.currentCount).toBe(1);
    expect(r.allowed).toBe(true);
  });
});
