import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // ~/ path alias used by app/routes/* must resolve at unit-test time too
  // (route files transitively import `~/services/...` even when only the
  // loader is exercised). Mirrors vitest.integration.config.ts.
  plugins: [tsconfigPaths()],
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests live under tests/integration/ and need real Postgres +
    // Redis + env injection — they run via `pnpm web:test`, not `pnpm test`.
    exclude: ['tests/integration/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    globals: false,
    typecheck: { enabled: false },
    pool: 'forks',
    // Boot-validated env vars satisfied at module-load time. Route files
    // (e.g. webhooks.tsx) transitively import `~/services/db.server.js` ->
    // `@winback/db` -> `getLogger` -> `getCoreConfig`, which validates these
    // synchronously. Mirrors the env block in apps/drainer/vitest.config.ts
    // / apps/scheduler / apps/cli. LOG_LEVEL=fatal keeps test output clean.
    env: {
      NODE_ENV: 'test',
      SERVICE_NAME: 'web.test',
      LOG_LEVEL: 'fatal',
    },
  },
});
