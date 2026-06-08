/**
 * Unit tests for `runBulkRescore` (the CLI command wrapper).
 *
 * Verifies the refuse-if-initialized guard + --force bypass + the not-found
 * branch. `CustomerScoreService.bulkRescore` itself is mocked — its behavior
 * (scoring, no-emit, flag-flip) is covered by the db unit + drainer
 * integration suites. Mirrors the dead-letter.test.ts mock pattern.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@winback/db', async () => {
  const actual = await vi.importActual<typeof import('@winback/db')>('@winback/db');
  return {
    ...actual,
    // Passthrough scope — the command's logic, not the scope plumbing, is under test.
    withTenantScope: vi.fn(async (_merchantId: string, fn: () => Promise<unknown>) => fn()),
    CustomerScoreRepository: vi.fn().mockImplementation(() => ({})),
    AuditLogRepository: vi.fn().mockImplementation(() => ({})),
    CustomerScoreService: vi.fn().mockImplementation(() => ({
      bulkRescore: vi
        .fn()
        .mockResolvedValue({ customersScored: 0, batches: 0, cohortSize: 0, durationMs: 0 }),
    })),
  };
});

const dbMod = await import('@winback/db');
const { runBulkRescore } = await import('../../src/commands/bulk-rescore.js');

const NOW = new Date('2026-06-08T12:00:00.000Z');

function makeStubPrisma(merchantRow: { scoringInitializedAt: Date | null } | null): {
  prisma: Parameters<typeof runBulkRescore>[0]['prisma'];
  findUnique: ReturnType<typeof vi.fn>;
} {
  const findUnique = vi.fn().mockResolvedValue(merchantRow);
  return {
    prisma: { merchant: { findUnique } } as unknown as Parameters<
      typeof runBulkRescore
    >[0]['prisma'],
    findUnique,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('runBulkRescore — merchant_not_found', () => {
  it('returns merchant_not_found; bulkRescore never constructed', async () => {
    const { prisma } = makeStubPrisma(null);

    const result = await runBulkRescore({
      prisma,
      merchantId: 'nope',
      force: false,
      actorId: 'op',
      now: NOW,
    });

    expect(result.kind).toBe('merchant_not_found');
    expect(vi.mocked(dbMod.CustomerScoreService)).not.toHaveBeenCalled();
  });
});

describe('runBulkRescore — refuse-if-initialized', () => {
  it('refuses (already_initialized) when scoringInitializedAt is set and NOT forced; bulkRescore NOT called', async () => {
    const initAt = new Date('2026-06-01T00:00:00.000Z');
    const { prisma } = makeStubPrisma({ scoringInitializedAt: initAt });

    const result = await runBulkRescore({
      prisma,
      merchantId: 'm1',
      force: false,
      actorId: 'op',
      now: NOW,
    });

    expect(result.kind).toBe('already_initialized');
    if (result.kind === 'already_initialized') {
      expect(result.merchantId).toBe('m1');
      expect(result.initializedAt).toBe(initAt);
    }
    expect(vi.mocked(dbMod.CustomerScoreService)).not.toHaveBeenCalled();
  });

  it('--force bypasses the guard: runs bulkRescore even when already initialized (still no events — Design B)', async () => {
    const bulkMock = vi
      .fn()
      .mockResolvedValue({ customersScored: 7, batches: 1, cohortSize: 5, durationMs: 3 });
    vi.mocked(dbMod.CustomerScoreService).mockImplementationOnce(
      () => ({ bulkRescore: bulkMock }) as unknown as InstanceType<typeof dbMod.CustomerScoreService>,
    );
    const { prisma } = makeStubPrisma({
      scoringInitializedAt: new Date('2026-06-01T00:00:00.000Z'),
    });

    const result = await runBulkRescore({
      prisma,
      merchantId: 'm1',
      force: true,
      actorId: 'op',
      now: NOW,
    });

    expect(result.kind).toBe('rescored');
    if (result.kind === 'rescored') {
      expect(result.customersScored).toBe(7);
    }
    expect(bulkMock).toHaveBeenCalledTimes(1);
  });
});

describe('runBulkRescore — first pass', () => {
  it('runs bulkRescore when scoringInitializedAt is null → rescored, with prisma + (merchantId, now, actorId)', async () => {
    const bulkMock = vi
      .fn()
      .mockResolvedValue({ customersScored: 42, batches: 2, cohortSize: 10, durationMs: 9 });
    vi.mocked(dbMod.CustomerScoreService).mockImplementationOnce(
      () => ({ bulkRescore: bulkMock }) as unknown as InstanceType<typeof dbMod.CustomerScoreService>,
    );
    const { prisma } = makeStubPrisma({ scoringInitializedAt: null });

    const result = await runBulkRescore({
      prisma,
      merchantId: 'm1',
      force: false,
      actorId: 'op-2',
      now: NOW,
    });

    expect(result.kind).toBe('rescored');
    if (result.kind === 'rescored') {
      expect(result.customersScored).toBe(42);
      expect(result.batches).toBe(2);
    }
    expect(bulkMock).toHaveBeenCalledTimes(1);
    expect(bulkMock).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ merchantId: 'm1', now: NOW, actorId: 'op-2' }),
    );
  });
});
