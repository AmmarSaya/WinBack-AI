// =============================================================================
// check-override-alignment.test.mjs — unit tests for the M11.x STEP F CI
// guardrail. Uses node:test + node:assert (zero new deps, matches the
// workspace-root location — no vitest sub-package home needed).
//
// Run: node --test ./scripts/check-override-alignment.test.mjs
//   or: pnpm test:overrides
//
// Test cases T1–T8 mirror the §8 plan surfaced in STEP F Phase 1.
// =============================================================================

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  collectDeclarations,
  findDrifts,
  formatFailureMessage,
  formatSuccessMessage,
} from './check-override-alignment.mjs';

// -----------------------------------------------------------------------------
// Helper — build a synthetic package input shape matching what
// findDrifts({ packages }) expects.
// -----------------------------------------------------------------------------
function pkg(file, name, { deps = {}, devDeps = {}, peerDeps = {} } = {}) {
  return {
    file,
    name,
    json: {
      name,
      dependencies: deps,
      devDependencies: devDeps,
      peerDependencies: peerDeps,
    },
  };
}

// -----------------------------------------------------------------------------
// collectDeclarations — direct unit coverage of the section scan.
// -----------------------------------------------------------------------------
describe('collectDeclarations', () => {
  test('finds entries across all three dependency sections', () => {
    const decls = collectDeclarations(
      {
        dependencies: { vitest: '2.1.9' },
        devDependencies: { zod: '4.4.3' },
        peerDependencies: { openai: '6.39.1' },
      },
      ['vitest', 'zod', 'openai'],
    );
    const sorted = decls.slice().sort((a, b) => a.key.localeCompare(b.key));
    assert.deepEqual(sorted, [
      { section: 'peerDependencies', key: 'openai', version: '6.39.1' },
      { section: 'dependencies', key: 'vitest', version: '2.1.9' },
      { section: 'devDependencies', key: 'zod', version: '4.4.3' },
    ]);
  });

  test('skips keys not in the override set', () => {
    const decls = collectDeclarations(
      { dependencies: { vitest: '2.1.9', pino: '9.5.0' } },
      ['vitest'],
    );
    assert.equal(decls.length, 1);
    assert.equal(decls[0].key, 'vitest');
  });
});

// -----------------------------------------------------------------------------
// T1–T8 — the 8 drift scenarios per the Phase 1 plan.
// -----------------------------------------------------------------------------
describe('findDrifts — scenarios T1–T8', () => {
  const baseOverrides = {
    vitest: '2.1.9',
    zod: '4.4.3',
    '@anthropic-ai/sdk': '0.100.1',
  };

  test('T1 — all aligned → no drifts', () => {
    const packages = [
      pkg('packages/ai/package.json', '@winback/ai', {
        deps: { '@anthropic-ai/sdk': '0.100.1', zod: '4.4.3' },
        devDeps: { vitest: '2.1.9' },
      }),
      pkg('apps/web/package.json', '@winback/web', {
        devDeps: { vitest: '2.1.9' },
      }),
    ];
    assert.deepEqual(findDrifts({ overrides: baseOverrides, packages }), []);
  });

  test('T2 — single drift (PR #66 reproduction) names key, versions, file, section', () => {
    const overrides = { '@anthropic-ai/sdk': '0.100.1', vitest: '2.1.9' };
    const packages = [
      pkg('packages/ai/package.json', '@winback/ai', {
        deps: { '@anthropic-ai/sdk': '0.65.0' }, // <-- drift
        devDeps: { vitest: '2.1.9' },
      }),
    ];
    const drifts = findDrifts({ overrides, packages });
    assert.equal(drifts.length, 1);
    assert.deepEqual(drifts[0], {
      file: 'packages/ai/package.json',
      packageName: '@winback/ai',
      section: 'dependencies',
      key: '@anthropic-ai/sdk',
      declared: '0.65.0',
      pinned: '0.100.1',
    });
  });

  test('T3 — multiple drifts reported separately', () => {
    const packages = [
      pkg('packages/ai/package.json', '@winback/ai', {
        deps: { '@anthropic-ai/sdk': '0.65.0', zod: '3.25.76' }, // both drift
      }),
      pkg('packages/db/package.json', '@winback/db', {
        deps: { zod: '4.4.3' }, // ok
        devDeps: { vitest: '2.0.0' }, // drift
      }),
    ];
    const drifts = findDrifts({ overrides: baseOverrides, packages });
    const fingerprints = drifts
      .map((d) => `${d.key}@${d.file}/${d.section}`)
      .sort();
    assert.deepEqual(fingerprints, [
      '@anthropic-ai/sdk@packages/ai/package.json/dependencies',
      'vitest@packages/db/package.json/devDependencies',
      'zod@packages/ai/package.json/dependencies',
    ]);
  });

  test('T4 — override key absent from a package.json is not flagged', () => {
    const packages = [
      pkg('packages/errors/package.json', '@winback/errors', {
        devDeps: { vitest: '2.1.9' }, // only declares vitest, none of the others
      }),
    ];
    assert.deepEqual(findDrifts({ overrides: baseOverrides, packages }), []);
  });

  test('T5 — package declares non-pinned deps; ignored', () => {
    const packages = [
      pkg('packages/logger/package.json', '@winback/logger', {
        deps: { pino: '^9.5.0', 'pino-pretty': '^11.3.0' }, // neither is overridden
      }),
    ];
    assert.deepEqual(findDrifts({ overrides: baseOverrides, packages }), []);
  });

  test('T6 — override-only (no per-package consumer anywhere) passes', () => {
    const overrides = { 'some-transitive-dep': '1.0.0' };
    const packages = [
      pkg('packages/ai/package.json', '@winback/ai', { deps: { other: '1.0.0' } }),
    ];
    assert.deepEqual(findDrifts({ overrides, packages }), []);
  });

  test('T7 — same key in deps AND devDeps, only the mismatched section reports', () => {
    const packages = [
      pkg('weird/package.json', 'weird', {
        deps: { vitest: '2.1.9' }, // ok
        devDeps: { vitest: '2.0.0' }, // drift
      }),
    ];
    const drifts = findDrifts({ overrides: baseOverrides, packages });
    assert.equal(drifts.length, 1);
    assert.equal(drifts[0].section, 'devDependencies');
    assert.equal(drifts[0].declared, '2.0.0');
    assert.equal(drifts[0].pinned, '2.1.9');
  });

  test('T8 — range per-package vs exact override is FAIL (strict equality)', () => {
    const packages = [
      pkg('packages/contracts/package.json', '@winback/contracts', {
        deps: { zod: '^4.4.3' }, // range, drifts because not exact-string
      }),
    ];
    const drifts = findDrifts({ overrides: baseOverrides, packages });
    assert.equal(drifts.length, 1);
    assert.equal(drifts[0].key, 'zod');
    assert.equal(drifts[0].declared, '^4.4.3');
    assert.equal(drifts[0].pinned, '4.4.3');
  });
});

// -----------------------------------------------------------------------------
// Format-function coverage — confirms the error message surface is
// developer-actionable (per STEP F addition A).
// -----------------------------------------------------------------------------
describe('formatFailureMessage', () => {
  test('includes key, both versions, file, section, packageName, fix steps, and POINTS-TO-CONSIDER reference', () => {
    const msg = formatFailureMessage([
      {
        file: 'packages/ai/package.json',
        packageName: '@winback/ai',
        section: 'dependencies',
        key: '@anthropic-ai/sdk',
        declared: '0.65.0',
        pinned: '0.100.1',
      },
    ]);
    assert.match(msg, /FAIL — 1 drift/);
    assert.match(msg, /@anthropic-ai\/sdk/);
    assert.match(msg, /0\.65\.0/);
    assert.match(msg, /0\.100\.1/);
    assert.match(msg, /packages\/ai\/package\.json/);
    assert.match(msg, /dependencies/);
    assert.match(msg, /@winback\/ai/);
    assert.match(msg, /How to fix:/);
    assert.match(msg, /pnpm install/);
    assert.match(msg, /lint:overrides/);
    assert.match(msg, /POINTS-TO-CONSIDER\.md/);
    assert.match(msg, /M11\.x/);
  });
});

describe('formatSuccessMessage', () => {
  test('reports both counts in a single line', () => {
    assert.equal(
      formatSuccessMessage({ overrideCount: 10, packageCount: 14 }),
      'check-override-alignment: OK — 10 override(s) aligned across 14 package.json files.',
    );
  });
});
