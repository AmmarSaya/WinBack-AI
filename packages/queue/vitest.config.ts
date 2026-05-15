import { defineConfig } from 'vitest/config';

// Unit-test config. Integration tests live under tests/integration/** and
// run via `vitest.integration.config.ts` (orchestrated by `pnpm queue:test`)
// — they need a running Redis and a REDIS_URL. Mirrors @winback/db's
// unit-vs-integration split exactly.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', '**/node_modules/**'],
    environment: 'node',
    globals: false,
    typecheck: { enabled: false },
    pool: 'forks',
  },
});
