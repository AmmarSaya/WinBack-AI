import { defineConfig } from 'vitest/config';

// Integration tests against a real Redis. Requires REDIS_URL set in the
// environment (orchestrated by `scripts/queue-test.mjs`).
//
// Tests serialize against the shared Redis (singleFork) to keep state
// reasoning simple. Each test wipes Redis via `beforeEach(resetRedis)`,
// so cross-test pollution is impossible by construction. The M10 full
// integration harness may introduce per-test keyspace isolation for
// parallelism; step 5 deliberately doesn't.
//
// 30s timeouts on test + hook match the queue-test.mjs health-check
// ceiling — if Redis is healthy by the time tests start, no individual
// test should approach this bound.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globals: false,
    typecheck: { enabled: false },
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
