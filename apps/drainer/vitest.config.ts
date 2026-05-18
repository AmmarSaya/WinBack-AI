import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests live under tests/integration/ and need real
    // Postgres + env injection — they run via `pnpm drainer:test`,
    // not `pnpm test`. Mirrors apps/web/vitest.config.ts.
    exclude: ['tests/integration/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    globals: false,
    typecheck: { enabled: false },
    pool: 'forks',
    env: {
      NODE_ENV: 'test',
      SERVICE_NAME: 'drainer.test',
      LOG_LEVEL: 'fatal',
    },
  },
});
