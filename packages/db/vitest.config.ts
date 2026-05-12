import { defineConfig } from 'vitest/config';

// Unit-test config. Integration tests live under tests/integration/** and
// run via `vitest.integration.config.ts` (orchestrated by `pnpm db:test`)
// — they need a running Postgres and a DATABASE_URL.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', '**/node_modules/**'],
    environment: 'node',
    globals: false,
    typecheck: { enabled: false },
    pool: 'forks',
    env: {
      NODE_ENV: 'test',
      SERVICE_NAME: 'db.test',
      LOG_LEVEL: 'fatal',
    },
  },
});
