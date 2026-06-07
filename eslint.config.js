// Flat ESLint config. Type-aware rules are enabled across the workspace.
// Per-app/per-file overrides (e.g., Remix route default exports) will be added
// in their respective epics; this root config is intentionally strict.

import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
    ],
  },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Single workspace-wide tsconfig.eslint.json — covers every TS/TSX/JS
        // file that should be linted, including tests, vitest configs, and
        // scripts/*.mjs. The per-package tsconfig.json files intentionally
        // scope to src/**/* for tsc's emit contract; this lint-only project
        // restores full coverage. See tsconfig.eslint.json header comment.
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      import: importPlugin,
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],

      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import/no-default-export': 'error',
      'import/no-cycle': ['error', { maxDepth: 5 }],
    },
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: ['./tsconfig.json', './packages/*/tsconfig.json', './apps/*/tsconfig.json'],
        },
      },
    },
  },
  {
    // Test files may use non-null assertions and console.
    files: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
  {
    // Vite + Vitest config files MUST default-export per the vite/vitest
    // public API contract (the loader looks up `default` from the loaded
    // module). The blanket import/no-default-export rule above is wrong
    // for these files; precisely-named exceptions keep the rule strict
    // for everything else.
    files: [
      '**/vitest.config.ts',
      '**/vitest.integration.config.ts',
      '**/vite.config.ts',
    ],
    rules: {
      'import/no-default-export': 'off',
    },
  },
  {
    // Scripts (build/test orchestrators) and the named integration-test
    // setup helpers legitimately use `console.log` to surface progress
    // and operator-relevant state. The general no-console rule is right
    // for production src; precisely-scoped exemptions for the operator
    // surfaces.
    files: [
      'scripts/**/*.mjs',
      'scripts/**/*.js',
      'scripts/**/*.ts',
      '**/tests/integration/setup.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Test files: `require-await` fires uniformly on the vitest mock
    // idiom — `vi.fn(async () => ...)` / `mockImplementation(async (...))`
    // where the mocked production function is async; the mock body
    // legitimately has nothing to await. A 15-site sample across drainer,
    // web, db, ai unit + integration tests confirmed 15/15 are
    // mock-signature-matching or interface-conformance or the
    // `withTenantScope(merchantId, async () => ...)` AsyncLocalStorage
    // contract (rule #7 in ARCHITECTURE.md). Stripping `async` to satisfy
    // the rule would break type-compatibility with the mocked production
    // signatures. Scope tightly to test files; src code keeps the rule on.
    files: ['**/*.test.ts', '**/*.spec.ts', '**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Remix routes + framework entry files require default exports.
    files: [
      'apps/web/app/routes/**/*.{ts,tsx}',
      'apps/web/app/root.tsx',
      'apps/web/app/entry.server.tsx',
      'apps/web/app/entry.client.tsx',
    ],
    rules: {
      'import/no-default-export': 'off',
    },
  },
);
