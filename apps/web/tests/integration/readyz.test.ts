import type { LoaderFunctionArgs } from '@remix-run/node';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertRead, createTestMerchant, getTestClient, resetDb } from './setup.js';

// NOTE: webhooks-loader.test.ts referenced in the B5 spec does not exist;
// we model this file on the closest live pattern, webhook-ingest.test.ts.
// The structural differences from that file are intentional:
//   - readyz exposes `loader`, not `action` (no body, no signing).
//   - We invoke loader with a plain Request and a LoaderFunctionArgs shape.
//   - We use vi.doMock to inject Postgres + Redis failures because /readyz
//     has no input-driven failure surface.
//
// Redis-mock target is `ioredis` (B5 a-strict refactor): readyz now
// instantiates its own minimal ioredis client from getRedisConfig() to keep
// apps/web off the @winback/queue dependency. The mock target moved from
// @winback/queue.createRedisClient to ioredis.Redis accordingly.

const SHOP = 'winback-test.myshopify.com';

interface ReadyzChecks {
  postgres: 'ok' | 'fail';
  redis: 'ok' | 'fail';
  outboxDlq: number;
  stallAgeSeconds: number;
}

interface ReadyzOkBody {
  status: 'ok';
  checks: ReadyzChecks;
  warnings?: string[];
}

interface ReadyzUnhealthyBody {
  status: 'unhealthy';
  checks: ReadyzChecks;
  errors: string[];
}

type ReadyzBody = ReadyzOkBody | ReadyzUnhealthyBody;

/**
 * Invoke the readyz loader with a fresh args object. Uses a dynamic
 * import on each call so that `vi.doMock` rewrites for the failure-path
 * tests are honored — a top-of-file `import { loader }` would lock the
 * real module into the test module graph before the mock could land.
 */
async function invokeReadyz(): Promise<Response> {
  const mod = await import('../../app/routes/readyz.js');
  // readyz.loader() takes no args (it's a side-effect-only health probe;
  // see app/routes/readyz.tsx:195). Calling without args matches the
  // production signature; LoaderFunctionArgs setup is unnecessary.
  return (await mod.loader()) as Response;
}

async function readBody(res: Response): Promise<ReadyzBody> {
  const text = await res.text();
  return JSON.parse(text) as ReadyzBody;
}

/**
 * Best-effort reset of the readyz module's memoized ioredis client. Called
 * in afterEach so a test's mocked or hung client does not bleed into the
 * next test. Wrapped in try/catch because the module may not have been
 * loaded yet, or its reset seam may differ if the module is under mock.
 */
async function resetReadyzRedis(): Promise<void> {
  try {
    const mod = await import('../../app/routes/readyz.js');
    if (typeof mod._resetReadyzRedisForTests === 'function') {
      mod._resetReadyzRedisForTests();
    }
  } catch {
    // Module not loaded yet, or under a mock that omits the seam.
    // Harmless — vi.resetModules() in beforeEach gives the next test a
    // fresh module instance anyway.
  }
}

/**
 * Insert N OutboxEvent rows directly via Prisma. Bypasses normal write
 * paths because we are populating the table for probe-side aggregation
 * tests, not exercising producer code.
 */
async function insertOutboxEvents(opts: {
  merchantId: string;
  count: number;
  deadLettered: boolean;
  createdAt?: Date;
}): Promise<void> {
  const client = getTestClient();
  await assertRead(async () => {
    const rows = Array.from({ length: opts.count }, (_, i) => ({
      merchantId: opts.merchantId,
      type: 'test.readyz_fixture',
      payload: { idx: i },
      createdAt: opts.createdAt ?? new Date(),
      deadLetteredAt: opts.deadLettered ? new Date() : null,
    }));
    await client.outboxEvent.createMany({ data: rows });
  });
}

/**
 * Build a mock for `~/services/db.server.js` whose `$queryRaw` behaves
 * differently per call index. Used for the timeout tests where we want
 * (e.g.) SELECT 1 to succeed but the DLQ count to hang.
 *
 * Pass an array of behaviors, one per expected $queryRaw call in order:
 *   - 'pass'  → delegate to the real test-container Prisma client
 *   - 'hang'  → return a never-resolving Promise (triggers PROBE_TIMEOUT_MS)
 *   - 'throw' → reject with a simulated error
 */
function mockDbWithPerCallBehavior(
  behaviors: Array<'pass' | 'hang' | 'throw'>,
): void {
  const realClient = getTestClient();
  vi.doMock('~/services/db.server.js', () => {
    let callIndex = 0;
    return {
      getPrisma: () => ({
        $queryRaw: (
          strings: TemplateStringsArray,
          ...values: unknown[]
        ) => {
          const behavior = behaviors[callIndex] ?? 'pass';
          callIndex += 1;
          switch (behavior) {
            case 'hang':
              return new Promise(() => {
                /* never resolves — relies on caller's race-with-timeout */
              });
            case 'throw':
              return Promise.reject(
                new Error(`simulated postgres failure (call ${callIndex})`),
              );
            case 'pass':
            default:
              return (
                realClient.$queryRaw as unknown as (
                  s: TemplateStringsArray,
                  ...v: unknown[]
                ) => Promise<unknown>
              )(strings, ...values);
          }
        },
      }),
    };
  });
}

/**
 * Build an ioredis mock for the readyz Redis-failure tests. Replaces the
 * `Redis` named export with a fake whose `.ping()` follows the chosen
 * behavior. Other surface (`disconnect`, `quit`) is no-ops so the test
 * cleanup paths don't blow up.
 */
function mockIoredisWithPingBehavior(behavior: 'throw' | 'hang'): void {
  vi.doMock('ioredis', async () => {
    const actual = await vi.importActual<typeof import('ioredis')>('ioredis');
    class FakeRedis {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      constructor(_url?: string, _options?: unknown) {
        // Intentionally accepts and discards the constructor args. Real
        // ioredis would open a connection here; we want NO real connection.
      }
      async ping(): Promise<string> {
        if (behavior === 'throw') {
          throw new Error('simulated redis outage');
        }
        // 'hang' — return a Promise that never resolves so the readyz
        // race-with-timeout fires.
        return new Promise<string>(() => {
          /* never resolves */
        });
      }
      disconnect(): void {
        /* noop */
      }
      async quit(): Promise<'OK'> {
        return 'OK';
      }
    }
    return {
      ...actual,
      Redis: FakeRedis,
    };
  });
}

describe('readyz (integration, real Postgres + Redis)', () => {
  beforeEach(async () => {
    await resetDb();
    // Reset module registry so previous test's vi.doMock doesn't bleed
    // through into a healthy-path test that runs after a failure-path
    // test in file order.
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    // Disconnect any memoized readyz Redis client BEFORE module/mocks
    // reset, so a hung-PING client doesn't leak between tests.
    await resetReadyzRedis();
    // Explicitly un-register the two modules we ever vi.doMock. Vitest's
    // vi.restoreAllMocks() restores spy implementations but does NOT
    // undo vi.doMock module registrations — without these doUnmock calls,
    // an ioredis mock from test (f)/(h) bleeds into later tests that
    // expect the real Redis container, and a db.server mock from (g)/(i)/
    // (j)/(k) bleeds into (a)-(e). Discovered B5 retry 2026-06-04.
    vi.doUnmock('ioredis');
    vi.doUnmock('~/services/db.server.js');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterAll(async () => {
    await getTestClient().$disconnect();
  });

  it('(a) healthy path → 200, status=ok, no warnings/errors', async () => {
    const res = await invokeReadyz();

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const body = await readBody(res);
    expect(body.status).toBe('ok');
    expect(body.checks.postgres).toBe('ok');
    expect(body.checks.redis).toBe('ok');
    expect(body.checks.outboxDlq).toBe(0);
    expect(body.checks.stallAgeSeconds).toBe(0);
    // warnings is either absent or empty on a clean run.
    if ('warnings' in body && body.warnings !== undefined) {
      expect(body.warnings).toHaveLength(0);
    }
  });

  it('(b) DLQ warn (6 dead-lettered rows) → 200, warning includes "outbox_dlq" and "6"', async () => {
    const merchantId = await createTestMerchant(SHOP);
    await insertOutboxEvents({ merchantId, count: 6, deadLettered: true });

    const res = await invokeReadyz();
    expect(res.status).toBe(200);

    const body = await readBody(res);
    expect(body.status).toBe('ok');
    expect(body.checks.outboxDlq).toBe(6);

    const okBody = body as ReadyzOkBody;
    expect(okBody.warnings).toBeDefined();
    const dlqWarning = okBody.warnings!.find((w) => w.includes('outbox_dlq'));
    expect(dlqWarning).toBeDefined();
    expect(dlqWarning).toContain('6');
    // 6 is above WARN (5) but below CRITICAL (50) — must NOT escalate.
    expect(dlqWarning).not.toContain('critical');
  });

  it('(c) DLQ critical (51 dead-lettered rows) → 200, warning escalated to "critical"', async () => {
    const merchantId = await createTestMerchant(SHOP);
    await insertOutboxEvents({ merchantId, count: 51, deadLettered: true });

    const res = await invokeReadyz();
    // STILL 200 per locked decision #2.
    expect(res.status).toBe(200);

    const body = await readBody(res);
    expect(body.status).toBe('ok');
    expect(body.checks.outboxDlq).toBe(51);

    const okBody = body as ReadyzOkBody;
    expect(okBody.warnings).toBeDefined();
    const dlqWarning = okBody.warnings!.find((w) => w.includes('outbox_dlq'));
    expect(dlqWarning).toBeDefined();
    expect(dlqWarning).toContain('critical');
    expect(dlqWarning).toContain('51');
  });

  it('(d) Stall warn (createdAt 6 min ago) → 200, warning includes "outbox_stall"', async () => {
    const merchantId = await createTestMerchant(SHOP);
    const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
    await insertOutboxEvents({
      merchantId,
      count: 1,
      deadLettered: false,
      createdAt: sixMinutesAgo,
    });

    const res = await invokeReadyz();
    expect(res.status).toBe(200);

    const body = await readBody(res);
    expect(body.status).toBe('ok');
    // Stall age should be ~360s; allow some slack for test execution.
    expect(body.checks.stallAgeSeconds).toBeGreaterThanOrEqual(360);
    expect(body.checks.stallAgeSeconds).toBeLessThan(360 + 60);

    const okBody = body as ReadyzOkBody;
    expect(okBody.warnings).toBeDefined();
    const stallWarning = okBody.warnings!.find((w) => w.includes('outbox_stall'));
    expect(stallWarning).toBeDefined();
    // 6 minutes is above WARN (300s = 5min) but below CRITICAL (900s = 15min).
    expect(stallWarning).not.toContain('critical');
  });

  it('(e) Stall critical (createdAt 16 min ago) → 200, warning escalated', async () => {
    const merchantId = await createTestMerchant(SHOP);
    const sixteenMinutesAgo = new Date(Date.now() - 16 * 60 * 1000);
    await insertOutboxEvents({
      merchantId,
      count: 1,
      deadLettered: false,
      createdAt: sixteenMinutesAgo,
    });

    const res = await invokeReadyz();
    // STILL 200 per locked decision #2.
    expect(res.status).toBe(200);

    const body = await readBody(res);
    expect(body.status).toBe('ok');
    expect(body.checks.stallAgeSeconds).toBeGreaterThanOrEqual(960);

    const okBody = body as ReadyzOkBody;
    expect(okBody.warnings).toBeDefined();
    const stallWarning = okBody.warnings!.find((w) => w.includes('outbox_stall'));
    expect(stallWarning).toBeDefined();
    expect(stallWarning).toContain('critical');
  });

  it('(f) Redis ping throws → 503, errors contains "redis"', async () => {
    mockIoredisWithPingBehavior('throw');

    const res = await invokeReadyz();
    expect(res.status).toBe(503);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const body = await readBody(res);
    expect(body.status).toBe('unhealthy');
    expect(body.checks.redis).toBe('fail');
    expect(body.checks.postgres).toBe('ok');

    const unhealthyBody = body as ReadyzUnhealthyBody;
    const redisError = unhealthyBody.errors.find((e) => e.startsWith('redis'));
    expect(redisError).toBeDefined();
  });

  it('(g) Postgres SELECT 1 throws → 503, errors contains "postgres"', async () => {
    // First $queryRaw call (SELECT 1) throws. Subsequent ones (DLQ / stall)
    // are unreachable because the withSystemScope callback bails out.
    mockDbWithPerCallBehavior(['throw']);

    const res = await invokeReadyz();
    expect(res.status).toBe(503);

    const body = await readBody(res);
    expect(body.status).toBe('unhealthy');
    expect(body.checks.postgres).toBe('fail');
    // Redis is real and reachable in this scenario — only Postgres mocked.
    expect(body.checks.redis).toBe('ok');

    const unhealthyBody = body as ReadyzUnhealthyBody;
    const pgError = unhealthyBody.errors.find((e) => e.startsWith('postgres'));
    expect(pgError).toBeDefined();
  });

  // --- TIMEOUT SPLIT TESTS (B5 a-strict) -------------------------------
  // The timeout split: PG canary / Redis PING timeout → 503 (unreachable);
  // DLQ / stall query timeout → 200 with warning (reachable but slow).
  // All four tests rely on a per-I/O timeout of 2_000ms in readyz.tsx.

  it('(h) Redis PING hangs → 503 via timeout, error contains "redis" and "timed out"', async () => {
    mockIoredisWithPingBehavior('hang');

    const res = await invokeReadyz();
    expect(res.status).toBe(503);

    const body = await readBody(res);
    expect(body.status).toBe('unhealthy');
    expect(body.checks.redis).toBe('fail');
    expect(body.checks.postgres).toBe('ok');

    const unhealthyBody = body as ReadyzUnhealthyBody;
    const redisError = unhealthyBody.errors.find((e) => e.startsWith('redis'));
    expect(redisError).toBeDefined();
    expect(redisError).toContain('timed out');
  }, 10_000);

  it('(i) Postgres DLQ count hangs → 200 with warning (DB reachable; operator-signal degraded)', async () => {
    // SELECT 1 passes (postgres is REACHABLE), DLQ count hangs → timeout
    // → warning. Stall MIN passes (delegates to real client; no rows so
    // returns null). Net: 200 with a single DLQ-probe-failed warning.
    mockDbWithPerCallBehavior(['pass', 'hang', 'pass']);

    const res = await invokeReadyz();
    // CRITICAL: must be 200, not 503. DB is up; only the operator-signal
    // query was slow. The split we explicitly designed in.
    expect(res.status).toBe(200);

    const body = await readBody(res);
    expect(body.status).toBe('ok');
    expect(body.checks.postgres).toBe('ok');
    expect(body.checks.redis).toBe('ok');
    // outboxDlq stays at its initial 0 because the COUNT query never
    // returned a value.
    expect(body.checks.outboxDlq).toBe(0);

    const okBody = body as ReadyzOkBody;
    expect(okBody.warnings).toBeDefined();
    const dlqWarning = okBody.warnings!.find((w) => w.includes('outbox_dlq'));
    expect(dlqWarning).toBeDefined();
    expect(dlqWarning).toContain('probe query failed');
    expect(dlqWarning).toContain('timed out');
  }, 10_000);

  it('(j) Postgres stall MIN hangs → 200 with warning (DB reachable; operator-signal degraded)', async () => {
    // SELECT 1 passes, DLQ count passes (empty table → 0), stall MIN hangs.
    mockDbWithPerCallBehavior(['pass', 'pass', 'hang']);

    const res = await invokeReadyz();
    // CRITICAL: must be 200, not 503.
    expect(res.status).toBe(200);

    const body = await readBody(res);
    expect(body.status).toBe('ok');
    expect(body.checks.postgres).toBe('ok');
    // stallAgeSeconds stays at its initial 0.
    expect(body.checks.stallAgeSeconds).toBe(0);

    const okBody = body as ReadyzOkBody;
    expect(okBody.warnings).toBeDefined();
    const stallWarning = okBody.warnings!.find((w) =>
      w.includes('outbox_stall'),
    );
    expect(stallWarning).toBeDefined();
    expect(stallWarning).toContain('probe query failed');
    expect(stallWarning).toContain('timed out');
  }, 10_000);

  it('(k) Postgres SELECT 1 hangs → 503 via timeout, error contains "postgres" and "timed out"', async () => {
    // SELECT 1 is the canary — its timeout means PG is unreachable.
    mockDbWithPerCallBehavior(['hang']);

    const res = await invokeReadyz();
    expect(res.status).toBe(503);

    const body = await readBody(res);
    expect(body.status).toBe('unhealthy');
    expect(body.checks.postgres).toBe('fail');
    expect(body.checks.redis).toBe('ok');

    const unhealthyBody = body as ReadyzUnhealthyBody;
    const pgError = unhealthyBody.errors.find((e) => e.startsWith('postgres'));
    expect(pgError).toBeDefined();
    expect(pgError).toContain('timed out');
  }, 10_000);
});
