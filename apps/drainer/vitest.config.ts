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
      // @winback/ai's getAiConfig() is called eagerly by the Epic F
      // batch 4 handler + worker. Placeholder values satisfy the Zod
      // discriminated-union at module-load time; no real LLM calls
      // happen in unit tests (provider is mocked or never invoked).
      AI_PROVIDER: 'deepseek',
      AI_MODEL: 'deepseek-v4-flash',
      AI_MAX_TOKENS: '300',
      AI_TEMPERATURE: '0.7',
      DEEPSEEK_API_KEY: 'sk-test-stub-for-boot-validation',
    },
  },
});
