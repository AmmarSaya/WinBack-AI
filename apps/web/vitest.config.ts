import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests live under tests/integration/ and need real Postgres +
    // Redis + env injection — they run via `pnpm web:test`, not `pnpm test`.
    exclude: ['tests/integration/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    globals: false,
    typecheck: { enabled: false },
    pool: 'forks',
  },
});
