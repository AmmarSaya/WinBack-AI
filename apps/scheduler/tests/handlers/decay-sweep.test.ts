/**
 * Unit tests for runDecaySweep.
 *
 * Covers:
 *   - the cross-tenant SELECT for initialized merchants runs
 *   - per-merchant `decayRescore` is invoked under `withTenantScope`
 *   - per-merchant try/catch wraps `decayRescore` (one failure doesn't
 *     terminate the sweep)
 *   - empty SELECT short-circuits (no decayRescore calls)
 *   - the actorId passed to decayRescore is 'scheduler'
 *
 * `@winback/db`'s `CustomerScoreService` + scope helpers are mocked at the
 * module boundary; the real cohort/emit behaviour is unit-tested in
 * `packages/db/tests/customer-score-service.test.ts` and proven against a
 * real DB in the drainer integration suite.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SchedulerContext } from '../../src/context.js';

const { decayRescoreMock } = vi.hoisted(() => ({ decayRescoreMock: vi.fn() }));

vi.mock('@winback/db', async () => {
  const actual = await vi.importActual<typeof import('@winback/db')>('@winback/db');
  return {
    ...actual,
    // Pass-through scope wrappers — run the callback directly so the
    // handler's control flow is exercised without AsyncLocalStorage setup.
    withSystemScope: vi.fn(async (_reason: unknown, cb: () => Promise<unknown>) => cb()),
    withTenantScope: vi.fn(async (_merchantId: unknown, cb: () => Promise<unknown>) => cb()),
    CustomerScoreRepository: vi.fn(),
    AuditLogRepository: vi.fn(),
    CustomerScoreService: vi.fn().mockImplementation(() => ({
      decayRescore: decayRescoreMock,
    })),
  };
});

const dbMod = await import('@winback/db');
const { runDecaySweep } = await import('../../src/handlers/decay-sweep.js');

interface MockedPrisma {
  $queryRaw: ReturnType<typeof vi.fn>;
}

function makeCtx(prisma: MockedPrisma): SchedulerContext {
  return {
    prisma: prisma as unknown as SchedulerContext['prisma'],
    queues: {} as SchedulerContext['queues'],
    shopifyConfig: {} as unknown as SchedulerContext['shopifyConfig'],
  };
}

const OK_RESULT = {
  customersEvaluated: 10,
  transitions: 2,
  emitted: 2,
  batches: 1,
  cohortSize: 8,
  durationMs: 5,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('runDecaySweep — happy path', () => {
  it('selects initialized merchants, calls decayRescore for each, returns successfully', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{ id: 'm-1' }, { id: 'm-2' }, { id: 'm-3' }]);
    decayRescoreMock.mockResolvedValue(OK_RESULT);

    await runDecaySweep(makeCtx({ $queryRaw: queryRaw }));

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(decayRescoreMock).toHaveBeenCalledTimes(3);
    // Each call is wrapped in withTenantScope(merchantId, ...).
    expect(vi.mocked(dbMod.withTenantScope)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(dbMod.withTenantScope).mock.calls.map((c) => c[0])).toEqual([
      'm-1',
      'm-2',
      'm-3',
    ]);
  });

  it('passes merchantId + actorId="scheduler" to decayRescore', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{ id: 'm-1' }]);
    decayRescoreMock.mockResolvedValue(OK_RESULT);

    const ctx = makeCtx({ $queryRaw: queryRaw });
    await runDecaySweep(ctx);

    expect(decayRescoreMock).toHaveBeenCalledWith(ctx.prisma, {
      merchantId: 'm-1',
      actorId: 'scheduler',
    });
  });

  it('empty SELECT short-circuits (no decayRescore calls)', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([]);
    await runDecaySweep(makeCtx({ $queryRaw: queryRaw }));

    expect(decayRescoreMock).not.toHaveBeenCalled();
    expect(vi.mocked(dbMod.withTenantScope)).not.toHaveBeenCalled();
  });
});

describe('runDecaySweep — failure containment', () => {
  it('one merchant decayRescore throw is caught; iteration continues', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{ id: 'm-1' }, { id: 'm-bad' }, { id: 'm-3' }]);
    decayRescoreMock
      .mockResolvedValueOnce(OK_RESULT)
      .mockRejectedValueOnce(new Error('cohort read failed'))
      .mockResolvedValueOnce(OK_RESULT);

    await expect(runDecaySweep(makeCtx({ $queryRaw: queryRaw }))).resolves.toBeUndefined();
    expect(decayRescoreMock).toHaveBeenCalledTimes(3);
  });
});

describe('runDecaySweep — scope', () => {
  it('wraps the whole sweep in withSystemScope (cross-tenant SELECT anchor)', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{ id: 'm-1' }]);
    decayRescoreMock.mockResolvedValue(OK_RESULT);

    await runDecaySweep(makeCtx({ $queryRaw: queryRaw }));

    expect(vi.mocked(dbMod.withSystemScope)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dbMod.withSystemScope).mock.calls[0]![0]).toBe('scoring.decay_sweep');
  });
});
