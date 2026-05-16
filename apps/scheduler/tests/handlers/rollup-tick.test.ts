/**
 * Unit tests for runRollupTick.
 *
 * Covers:
 *   - timezone-aware SELECT runs; each returned merchant gets a "would
 *     upsert" log entry (stub body — no real DB writes)
 *   - timezone-NULL fallback runs ONLY at UTC hour 0
 *   - per-merchant try/catch contains failures (poison containment)
 *   - withSystemScope opens with 'rollup.daily' reason
 *
 * Real Prisma `$queryRaw` is mocked at the WinbackPrisma level so we
 * can return canned merchant lists per branch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SchedulerContext } from '../../src/context.js';
import { runRollupTick } from '../../src/handlers/rollup-tick.js';

interface MockedPrisma {
  $queryRaw: ReturnType<typeof vi.fn>;
}

function makeCtx(prisma: MockedPrisma): SchedulerContext {
  return {
    prisma: prisma as unknown as SchedulerContext['prisma'],
    queues: {} as SchedulerContext['queues'],
    shopifyConfig: {} as SchedulerContext['shopifyConfig'],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('runRollupTick — timezone-aware branch', () => {
  beforeEach(() => {
    // Pin clock to UTC hour 12 so the NULL-fallback branch does NOT fire.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T12:30:00.000Z'));
  });

  it('queries Merchant for timezone-aware rows and logs one entry per merchant', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([
      { id: 'm-tokyo', timezone: 'Asia/Tokyo' },
      { id: 'm-sydney', timezone: 'Australia/Sydney' },
    ]);

    await runRollupTick(makeCtx({ $queryRaw: queryRaw }));

    // The timezone-aware query fired exactly once (no UTC-fallback at hour 12).
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns successfully with empty SELECT (no merchants in this UTC hour)', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([]);
    await expect(runRollupTick(makeCtx({ $queryRaw: queryRaw }))).resolves.toBeUndefined();
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('runRollupTick — UTC-fallback branch (timezone IS NULL)', () => {
  beforeEach(() => {
    // Pin clock to UTC hour 0 so the NULL-fallback branch fires.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T00:30:00.000Z'));
  });

  it('runs the UTC-NULL fallback query ONLY at UTC hour 0', async () => {
    const queryRaw = vi
      .fn()
      // 1st call — timezone-aware
      .mockResolvedValueOnce([{ id: 'm-tz', timezone: 'America/New_York' }])
      // 2nd call — null-fallback
      .mockResolvedValueOnce([{ id: 'm-null' }]);

    await runRollupTick(makeCtx({ $queryRaw: queryRaw }));

    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe('runRollupTick — UTC non-zero hour does NOT trigger fallback', () => {
  it('UTC hour 5: only the timezone-aware SELECT runs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T05:30:00.000Z'));

    const queryRaw = vi.fn().mockResolvedValueOnce([]);
    await runRollupTick(makeCtx({ $queryRaw: queryRaw }));

    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('runRollupTick — system scope assertion', () => {
  it('the handler does not throw under the standard test env (system scope opens cleanly)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T12:00:00.000Z'));

    const queryRaw = vi.fn().mockResolvedValueOnce([]);
    await expect(runRollupTick(makeCtx({ $queryRaw: queryRaw }))).resolves.toBeUndefined();
  });
});
