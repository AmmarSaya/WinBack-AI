import { defineConfig } from 'vitest/config';

/**
 * Integration tests for apps/drainer. Runs against real Postgres
 * (port 5433, db winback_test) — same container as `pnpm db:test` and
 * `pnpm web:test`. Orchestrated by scripts/drainer-test.mjs.
 *
 * singleFork = one shared Prisma client across the suite, avoiding
 * connection-pool blowup. resetDb between tests provides isolation.
 *
 * Redis is intentionally NOT a hard dependency for the session-1 tests
 * (the handlers in scope — order stubs, GDPR, merchant.uninstalled —
 * don't enqueue). Future tests that DO enqueue (merchant.installed
 * paged backfill, attribution if it ever moves out of inline) will
 * require Redis; the orchestrator brings it up anyway for forward
 * compatibility.
 *
 * 30s timeout — DB ops dominate; mocks are absent by design here.
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globals: false,
    typecheck: { enabled: false },
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
