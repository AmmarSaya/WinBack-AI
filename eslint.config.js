// Flat ESLint config. Type-aware rules are enabled across the workspace.
// Per-app/per-file overrides (e.g., Remix route default exports) will be added
// in their respective epics; this root config is intentionally strict.

import { defineConfig } from 'eslint/config';
import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';

// `tseslint.config(...)` was deprecated in favour of ESLint core's
// `defineConfig(...)` per typescript-eslint's migration note; same
// argument shape, same expansion of `tseslint.configs.*` arrays, just
// the recommended host helper now lives in `eslint/config`.
export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      // packages/db/scripts/db-reset.mjs is operator-only tooling
      // (manual local-dev DB reset). It is intentionally outside every
      // package tsconfig's `include` so it does not affect tsc emit;
      // typescript-eslint's projectService consequently can't parse it.
      // Ignoring it here is the honest path — adding it to
      // tsconfig.eslint.json's include would pull operator tooling into
      // type-checking for zero benefit on a non-lint-critical surface.
      'packages/db/scripts/**/*.mjs',
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
    // module). ESLint flat-config files MUST default-export per the
    // ESLint flat-config contract (eslint reads `default` from the
    // loaded module). The blanket import/no-default-export rule above
    // is wrong for these files; precisely-named exceptions keep the
    // rule strict for everything else.
    files: [
      '**/vitest.config.ts',
      '**/vitest.integration.config.ts',
      '**/vite.config.ts',
      'eslint.config.js',
    ],
    rules: {
      'import/no-default-export': 'off',
    },
  },
  {
    // Ambient module declarations (`*.d.ts`) genuinely require default
    // exports when the declared module's runtime contract uses one. The
    // only repo `.d.ts` site firing the rule is `apps/web/app/vite-env.d.ts`
    // (`declare module '*.css?url' { ...; export default url; }`) — the
    // Vite CSS-URL import contract. The rule doesn't apply to ambient
    // module declarations; relax it for the file type. (`app-bridge.d.ts`
    // uses `declare module 'react'` with no default export — innocent of
    // the rule, unaffected by the relaxation.)
    files: ['**/*.d.ts'],
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
  {
    // Test files: relax the no-unsafe-* family + consistent-type-imports
    // + import/order. The justification is rule-vs-framework, NOT "tests
    // don't need to be type-safe":
    //
    //  - no-unsafe-{assignment,member-access,argument,call,return}:
    //    vi.fn / vi.spyOn types their callback args as `any` (by design
    //    — mocks can substitute any signature); the rule fires
    //    uniformly on every mocked-call body in the suite. The 12 SRC
    //    no-unsafe-* findings were extracted as real type fixes in 5b
    //    (975be82 — settings.tsx loader typing + 3 AI-provider error-
    //    mapper narrowings). After 5b, every remaining no-unsafe-* hit
    //    lives in tests/mocks/scripts cascade, not SRC. 5d Phase 1
    //    classified all 179 no-unsafe-* hits at this point in the
    //    arc and confirmed ZERO live in `apps/*/{app,src}` or
    //    `packages/*/src` — so this relaxation can mask no real SRC
    //    finding because no real SRC finding exists. Verified zero
    //    `import.*from.*tests/` across `apps/*/{app,src}` and
    //    `packages/*/src` → no src module pulls a test helper into
    //    the production path, so the relaxed surface is genuinely
    //    test-only.
    //
    //  - consistent-type-imports: the vitest `importOriginal<typeof
    //    import('@winback/X')>()` idiom is the documented vitest
    //    generic; the rule forbids `import()` type annotations. The
    //    two viable refactors both fail (`import * as` runtime-loads
    //    the module, defeating the lazy mock; `type Original = typeof
    //    import(...)` relocates the same expression). Rule-vs-framework.
    //
    //  - import/order: `vi.mock` factories MUST appear before the
    //    imports they mock (vitest hoisting semantic). The rule wants
    //    all imports grouped at the top. Framework constraint.
    files: ['**/*.test.ts', '**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
      'import/order': 'off',
    },
  },
  {
    // Scripts (build/test/CI orchestrators and the M11.x override-
    // alignment guardrail) JSON.parse package.json values from disk.
    // The parsed structure is untyped `any` and cascades through every
    // access site — firing the no-unsafe-* family + restrict-template-
    // expressions on the propagation paths and restrict-plus-operands
    // on the path-join arithmetic in the orchestrators. Runtime safety
    // is preserved at the source: check-override-alignment.mjs guards
    // every JSON-parsed branch with `typeof X !== 'object'` checks +
    // strict `!==` comparisons (a typo or shape drift surfaces as drift
    // rather than silently aligning — the CI gate's own protection).
    // Same any-source as the no-unsafe-* relaxation; restrict-template-
    // expressions falls out of the same cascade, hence symmetric off.
    files: ['scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
    },
  },
);
