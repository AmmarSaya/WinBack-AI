import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

/**
 * Integration tests for apps/web. Runs against real Postgres (port 5433,
 * db winback_test) and real Redis (port 6380), orchestrated by
 * scripts/web-test.mjs. Mirrors packages/db's pnpm db:test shape.
 *
 * singleFork = one shared Prisma client across the suite, avoiding
 * connection-pool blowup. resetDb between tests provides isolation.
 *
 * 30s default timeout — DB ops dominate; mocks are absent by design here.
 */
export default defineConfig({
  // ~/ path alias used by app/routes/* must resolve at test time too.
  plugins: [tsconfigPaths()],
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
