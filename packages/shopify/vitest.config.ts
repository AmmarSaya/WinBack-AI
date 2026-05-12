import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    typecheck: { enabled: false },
    pool: 'forks',
    env: {
      NODE_ENV: 'test',
      SERVICE_NAME: 'shopify.test',
      LOG_LEVEL: 'fatal',
    },
  },
});
