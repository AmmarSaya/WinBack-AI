import { Redis } from 'ioredis';

import { closeQueues } from '../../src/queues.js';

/**
 * Test admin client used by the integration suite for FLUSHDB and any
 * other administrative commands. SEPARATE from the @winback/queue
 * package's internal shared client (created lazily by getQueues) — the
 * split is intentional: production code uses the package's API only;
 * the admin client is for test-only operations that aren't part of the
 * package's contract.
 */
let _adminClient: Redis | null = null;

export function getTestRedisClient(): Redis {
  if (_adminClient === null) {
    const url = process.env['REDIS_URL'];
    if (url === undefined || url === '') {
      throw new Error(
        '[queue/integration] REDIS_URL not set. Run via `pnpm queue:test` ' +
          'so the script injects it; the bare `pnpm --filter @winback/queue ' +
          "exec vitest -c vitest.integration.config.ts` won't.",
      );
    }
    _adminClient = new Redis(url, {
      connectionName: 'queue.test.admin',
      // BullMQ-style maxRetriesPerRequest: null is NOT applied here. The
      // admin client only issues short administrative commands; the
      // default ioredis retry behavior is appropriate.
    });
  }
  return _adminClient;
}

/**
 * Wipes all keys in the current Redis database. Called in `beforeEach`
 * so each test starts with a clean slate. Matches `@winback/db`'s
 * `resetDb` pattern — same semantic ("clean slate per test"), different
 * implementation (FLUSHDB instead of sequenced deleteMany).
 */
export async function resetRedis(): Promise<void> {
  const client = getTestRedisClient();
  await client.flushdb();
}

/**
 * Final teardown helper — closes the package's shared queue connections
 * AND the test admin client. Wrapped in try/catch per Checkpoint 3.
 *
 * On failure: THROW so vitest marks the suite failed and the runner
 * exits with code 1 naturally. Do NOT call `process.exit(1)` — that
 * would kill vitest before it can report which tests passed and which
 * failed, hiding the real signal under a generic process-died error.
 *
 * On success: log a specific message confirming the teardown completed
 * cleanly. The message is grep-able from CI logs to confirm there were
 * no lingering connections at the end of the suite.
 */
export async function teardown(): Promise<void> {
  try {
    await closeQueues();
    if (_adminClient !== null) {
      await _adminClient.quit();
      _adminClient = null;
    }
    console.log(
      '[queue/integration] teardown completed cleanly — all connections closed.',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[queue/integration] teardown failed: ${message}. ` +
        'Vitest will mark the suite failed and exit with code 1.',
      err instanceof Error ? { cause: err } : undefined,
    );
  }
}
