/**
 * Tests for withSystemScope's runtime regex guard.
 *
 * After step 2 of the pre-CP-2 prep, `withSystemScope` accepts only
 * `SystemScopeReason | \`test.${string}\`` at the type level. The inputs
 * exercised below are deliberately malformed — they would not pass TS
 * compile in production code. The `as never` cast at each call site
 * acknowledges this intent: "I am deliberately bypassing the type system
 * to exercise the runtime fallback."
 *
 * The two-layer design is deliberate. Typed callers see typos at compile
 * time; untyped or `@ts-ignore`-bypassed callers see them at runtime.
 * Both gates point at the same regex.
 */

import { describe, expect, it } from 'vitest';

import { TenantScopeError } from '../src/errors.js';
import { getTenantScope, withSystemScope, withTenantScope } from '../src/tenant-scope.js';

describe('withSystemScope reason validation (runtime regex)', () => {
  it('rejects empty string', async () => {
    await expect(
      withSystemScope('' as never, async () => undefined),
    ).rejects.toThrow(TenantScopeError);
  });

  it('rejects whitespace-only', async () => {
    await expect(
      withSystemScope('   ' as never, async () => undefined),
    ).rejects.toThrow(TenantScopeError);
  });

  it('rejects a single word with no dot', async () => {
    await expect(
      withSystemScope('system' as never, async () => undefined),
    ).rejects.toThrow(TenantScopeError);
  });

  it('rejects uppercase or special chars', async () => {
    await expect(
      withSystemScope('Fix-bug' as never, async () => undefined),
    ).rejects.toThrow(TenantScopeError);
    await expect(
      withSystemScope('outbox drain' as never, async () => undefined),
    ).rejects.toThrow(TenantScopeError);
    await expect(
      withSystemScope('CRON.cleanup' as never, async () => undefined),
    ).rejects.toThrow(TenantScopeError);
  });

  it('rejects multi-dot reasons (regression: web.index.lookup latent bug)', async () => {
    // The pre-step-2 codebase had `web.index.lookup` in apps/web/_index.tsx,
    // which fails the regex but was never test-exercised. Step 2 renamed
    // it to `web.index_lookup` and registered it. This guards the regression.
    await expect(
      withSystemScope('web.index.lookup' as never, async () => undefined),
    ).rejects.toThrow(TenantScopeError);
  });

  it('rejects `test.` with empty suffix (TS template-literal accepts; runtime regex rejects)', async () => {
    // The `test.${string}` escape on the type signature is permissive —
    // it accepts `'test.'` (empty ${string}). The runtime regex requires
    // at least one [a-z] after the dot. This test pins that divergence
    // so the runtime gate isn't accidentally loosened.
    await expect(
      withSystemScope('test.', async () => undefined),
    ).rejects.toThrow(TenantScopeError);
  });

  it('accepts proper category.action format (test.* escape)', async () => {
    const observed: string[] = [];
    // All inputs here are valid by format. The `test.*` template-literal
    // escape on the type signature lets us pass them without registering
    // them in SYSTEM_SCOPE_REASONS — that's by design for test scenarios.
    for (const reason of [
      'test.outbox_drain',
      'test.cron_cleanup',
      'test.scenario_one',
      'test.scenario_two',
    ] as const) {
      await withSystemScope(reason, async () => {
        const scope = getTenantScope();
        if (scope?.kind === 'system') observed.push(scope.reason);
      });
    }
    expect(observed).toEqual([
      'test.outbox_drain',
      'test.cron_cleanup',
      'test.scenario_one',
      'test.scenario_two',
    ]);
  });
});

describe('nested tenant scope rules', () => {
  it('allows nested tenant scope with the same merchantId', async () => {
    await withTenantScope('m_1', async () => {
      await withTenantScope('m_1', async () => {
        expect(getTenantScope()).toEqual({ kind: 'tenant', merchantId: 'm_1' });
      });
    });
  });

  it('rejects nested tenant scope with a different merchantId', async () => {
    await withTenantScope('m_1', async () => {
      await expect(
        withTenantScope('m_2', async () => undefined),
      ).rejects.toThrow(TenantScopeError);
    });
  });
});
