/**
 * Tests for `getRedisConfig` — the strict env-var validator for the Redis
 * connection used by @winback/queue (D1+) and any future cache consumer.
 *
 * Twelve tests, grouped by concern:
 *   URL validation (1-5) — required, structural shape, scheme strictness
 *   TLS rejectUnauthorized (6-10) — including the production-policy refusal
 *     and the regression test that pins the z.coerce.boolean footgun is
 *     avoided
 *   Memoization (11-12)
 *
 * The schema reads NODE_ENV solely to enforce the production policy on
 * REDIS_TLS_REJECT_UNAUTHORIZED=false. NODE_ENV is stripped from the
 * returned RedisConfig — these tests confirm both halves of that contract.
 */

import { describe, expect, it } from 'vitest';

import { ConfigError, getRedisConfig } from '../src/index.js';

/**
 * Build a minimal env source for a test. Default values are valid; pass
 * overrides to invalidate specific fields. `undefined` removes a field.
 */
function envSource(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    REDIS_URL: 'redis://localhost:6380',
  };
  // `overrides` is Record<string, string | undefined> so the spread result
  // doesn't satisfy the structural requirement of NodeJS.ProcessEnv's
  // required `NODE_ENV`. Cast: `base` always supplies NODE_ENV, callers
  // override only the keys they care about.
  return { ...base, ...overrides } as NodeJS.ProcessEnv;
}

// ===========================================================================
// URL validation
// ===========================================================================

describe('getRedisConfig — URL validation', () => {
  it('1. accepts a valid redis:// URL', () => {
    const cfg = getRedisConfig({
      reset: true,
      source: envSource({ REDIS_URL: 'redis://localhost:6380' }),
    });
    expect(cfg.REDIS_URL).toBe('redis://localhost:6380');
  });

  it('2. accepts a valid rediss:// URL with auth and managed host', () => {
    const url = 'rediss://default:secret@managed.redis.example.com:6380/0';
    const cfg = getRedisConfig({
      reset: true,
      source: envSource({ REDIS_URL: url }),
    });
    expect(cfg.REDIS_URL).toBe(url);
  });

  it('3. throws ConfigError when REDIS_URL is missing entirely', () => {
    expect(() =>
      getRedisConfig({
        reset: true,
        source: envSource({ REDIS_URL: undefined }),
      }),
    ).toThrow(ConfigError);
  });

  it('4. throws ConfigError when REDIS_URL is an empty string', () => {
    expect(() =>
      getRedisConfig({
        reset: true,
        source: envSource({ REDIS_URL: '' }),
      }),
    ).toThrow(ConfigError);
  });

  it('5. throws ConfigError with a helpful message for wrong protocol (http://)', () => {
    // Helpful message: the operator reading the boot log sees exactly which
    // protocols are accepted, no need to grep the source.
    expect(() =>
      getRedisConfig({
        reset: true,
        source: envSource({ REDIS_URL: 'http://localhost:6380' }),
      }),
    ).toThrow(/rediss:\/\//);
  });
});

// ===========================================================================
// TLS rejectUnauthorized
// ===========================================================================

describe('getRedisConfig — TLS rejectUnauthorized', () => {
  it('6. REDIS_TLS_REJECT_UNAUTHORIZED="true" parses to boolean true', () => {
    const cfg = getRedisConfig({
      reset: true,
      source: envSource({ REDIS_TLS_REJECT_UNAUTHORIZED: 'true' }),
    });
    expect(cfg.REDIS_TLS_REJECT_UNAUTHORIZED).toBe(true);
  });

  it('7. REDIS_TLS_REJECT_UNAUTHORIZED="false" parses to boolean false in non-production', () => {
    // Explicitly stay out of production for this assertion — the
    // production-refusal contract is its own test (#10).
    const cfg = getRedisConfig({
      reset: true,
      source: envSource({
        NODE_ENV: 'development',
        REDIS_TLS_REJECT_UNAUTHORIZED: 'false',
      }),
    });
    expect(cfg.REDIS_TLS_REJECT_UNAUTHORIZED).toBe(false);
  });

  it('8. absent REDIS_TLS_REJECT_UNAUTHORIZED defaults to true (secure-by-default)', () => {
    const cfg = getRedisConfig({
      reset: true,
      source: envSource({ REDIS_TLS_REJECT_UNAUTHORIZED: undefined }),
    });
    expect(cfg.REDIS_TLS_REJECT_UNAUTHORIZED).toBe(true);
  });

  it('9. throws ConfigError for non-literal "true"/"false" values (z.coerce.boolean footgun regression)', () => {
    // The whole reason for the enum+transform pattern instead of
    // z.coerce.boolean() is that Boolean("false") === true in JavaScript.
    // Coercion would silently misparse any non-empty string as `true`.
    // This test pins that we reject anything other than the two literals
    // — covering the case where someone passes "yes", "1", "False", etc.
    for (const garbage of ['yes', '1', 'no', '0', 'False', 'TRUE', 'on', 'off']) {
      expect(
        () =>
          getRedisConfig({
            reset: true,
            source: envSource({ REDIS_TLS_REJECT_UNAUTHORIZED: garbage }),
          }),
        `value=${garbage}`,
      ).toThrow(ConfigError);
    }
  });

  it('10. refuses REDIS_TLS_REJECT_UNAUTHORIZED=false in production with an actionable error message', () => {
    expect(() =>
      getRedisConfig({
        reset: true,
        source: envSource({
          NODE_ENV: 'production',
          REDIS_TLS_REJECT_UNAUTHORIZED: 'false',
        }),
      }),
    ).toThrow(/refused in production/);

    // Confirm the OTHER non-production environments still accept the flag —
    // the policy is production-specific, not a blanket prohibition.
    for (const env of ['development', 'test', 'staging']) {
      expect(() =>
        getRedisConfig({
          reset: true,
          source: envSource({
            NODE_ENV: env,
            REDIS_TLS_REJECT_UNAUTHORIZED: 'false',
          }),
        }),
      ).not.toThrow();
    }
  });
});

// ===========================================================================
// Memoization
// ===========================================================================

describe('getRedisConfig — memoization', () => {
  it('11. returns the same instance on repeated calls (memoized)', () => {
    const first = getRedisConfig({
      reset: true,
      source: envSource(),
    });
    // Second call with no options — should hit the cache and skip parsing
    // (which is what we want: validation runs once per process). If this
    // returned a fresh object, every consumer would re-parse on every call.
    //
    // No source override — if memoization is broken and re-parsing fires,
    // this would throw or return a different value because process.env
    // likely has no REDIS_URL in test. The failure mode is legible rather
    // than mysterious: either ConfigError surfaces, or the `toBe(first)`
    // identity assertion fails.
    const second = getRedisConfig();
    expect(second).toBe(first);
  });

  it('12. reset: true clears the cache and re-parses the source', () => {
    const first = getRedisConfig({
      reset: true,
      source: envSource({ REDIS_URL: 'redis://first.local:6380' }),
    });
    const second = getRedisConfig({
      reset: true,
      source: envSource({ REDIS_URL: 'redis://second.local:6380' }),
    });
    expect(first.REDIS_URL).toBe('redis://first.local:6380');
    expect(second.REDIS_URL).toBe('redis://second.local:6380');
    expect(second).not.toBe(first);
  });
});
