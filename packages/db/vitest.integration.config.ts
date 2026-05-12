import { defineConfig } from 'vitest/config';

// Integration tests against a real Postgres. Requires DATABASE_URL set
// in the environment (orchestrated by `scripts/db-test.mjs`).
//
// Tests serialize against the shared DB (singleFork) to keep state
// reasoning simple. The full M10 harness will introduce per-test schemas
// for parallelism; M3-Smoke deliberately doesn't.
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
