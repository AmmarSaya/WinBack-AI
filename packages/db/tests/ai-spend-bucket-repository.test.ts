/**
 * Unit tests for AiSpendBucketRepository.
 *
 * Mocked-Prisma pattern (same shape as ai-generation-repository.test.ts
 * / message-repository.test.ts). Exercises control flow + arg shapes:
 * UTC-midnight truncation on the upsert key, the {increment} operator
 * semantics for atomic accumulation, BigInt boundary preservation in
 * sumMonthSpend, and tx-parameter honoring on all three methods.
 *
 * The mock's `upsert` handler implements the Postgres ON CONFLICT DO
 * UPDATE semantics in JS so we can verify the increment operators
 * actually apply arithmetic — not just that the call shape is right.
 * The `aggregate` handler mirrors Prisma's `_sum.<field>: BigInt | null`
 * return contract so the BigInt boundary is exercised.
 */

import { describe, expect, it, vi } from 'vitest';

import type { WinbackPrisma } from '../src/client.js';
import { AiSpendBucketRepository } from '../src/repositories/ai-spend-bucket.repository.js';

interface AiSpendBucketRow {
  id: string;
  merchantId: string;
  date: Date;
  spentMicrocents: bigint;
  generationCount: number;
}

interface MockState {
  rows: AiSpendBucketRow[];
  nextId: number;
  callLog: string[];
}

function rowKey(merchantId: string, date: Date): string {
  return `${merchantId}|${date.toISOString()}`;
}

/** Apply Prisma update-operator shapes onto a row. Currently supports `{ increment }`. */
function applyUpdate(row: AiSpendBucketRow, data: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && 'increment' in (value)) {
      const delta = (value).increment;
      if (field === 'spentMicrocents') {
        row.spentMicrocents = row.spentMicrocents + (delta as bigint);
      } else if (field === 'generationCount') {
        row.generationCount = row.generationCount + (delta as number);
      } else {
        throw new Error(`unhandled increment field in mock: ${field}`);
      }
    } else {
      // Plain set
      (row as unknown as Record<string, unknown>)[field] = value;
    }
  }
}

function makeMockPrisma(initial: Partial<MockState> = {}) {
  const state: MockState = {
    rows: initial.rows ?? [],
    nextId: initial.nextId ?? 1,
    callLog: initial.callLog ?? [],
  };

  const aiSpendBucketDelegate = {
    upsert: vi.fn(
      async (args: {
        where: { merchantId_date: { merchantId: string; date: Date } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
        select?: unknown;
      }) => {
        const { merchantId, date } = args.where.merchantId_date;
        state.callLog.push(
          `aiSpendBucket.upsert key=${rowKey(merchantId, date)} updateKeys=${Object.keys(args.update).join(',')}`,
        );
        const existing = state.rows.find(
          (r) => r.merchantId === merchantId && r.date.toISOString() === date.toISOString(),
        );
        if (existing !== undefined) {
          applyUpdate(existing, args.update);
          return { id: existing.id };
        }
        const id = `bucket_${String(state.nextId)}`;
        state.nextId += 1;
        const row: AiSpendBucketRow = {
          id,
          merchantId: args.create.merchantId as string,
          date: args.create.date as Date,
          spentMicrocents:
            (args.create.spentMicrocents as bigint | undefined) ?? 0n,
          generationCount:
            (args.create.generationCount as number | undefined) ?? 0,
        };
        state.rows.push(row);
        return { id };
      },
    ),
    aggregate: vi.fn(
      async (args: {
        where: { merchantId?: string; date?: { gte?: Date } };
        _sum: { spentMicrocents?: boolean };
      }) => {
        state.callLog.push(
          `aiSpendBucket.aggregate where=${JSON.stringify({
            merchantId: args.where.merchantId,
            dateGte: args.where.date?.gte?.toISOString() ?? null,
          })}`,
        );
        const matched = state.rows.filter((r) => {
          if (args.where.merchantId !== undefined && r.merchantId !== args.where.merchantId) {
            return false;
          }
          if (
            args.where.date?.gte !== undefined &&
            r.date.getTime() < args.where.date.gte.getTime()
          ) {
            return false;
          }
          return true;
        });
        if (matched.length === 0) {
          // Prisma's contract: _sum.<field> is null when zero rows matched.
          return { _sum: { spentMicrocents: null } };
        }
        const sum = matched.reduce((acc, r) => acc + r.spentMicrocents, 0n);
        return { _sum: { spentMicrocents: sum } };
      },
    ),
  };

  const prisma = { aiSpendBucket: aiSpendBucketDelegate } as unknown as WinbackPrisma;
  return { prisma, state, aiSpendBucketDelegate };
}

// ===========================================================================
// getOrCreateForDay
// ===========================================================================

describe('AiSpendBucketRepository.getOrCreateForDay', () => {
  it('creates a new bucket row at UTC midnight when none exists', async () => {
    const { prisma, state, aiSpendBucketDelegate } = makeMockPrisma();
    const repo = new AiSpendBucketRepository(prisma);

    // Pass a date with time-of-day components — repository MUST truncate.
    const inputDate = new Date('2026-06-15T14:23:45.123Z');
    const result = await repo.getOrCreateForDay({
      merchantId: 'm_1',
      date: inputDate,
    });

    expect(result).toEqual({ bucketId: 'bucket_1' });
    expect(state.rows).toHaveLength(1);
    const row = state.rows[0]!;
    expect(row.merchantId).toBe('m_1');
    // Date stored is UTC midnight of the same calendar day.
    expect(row.date.toISOString()).toBe('2026-06-15T00:00:00.000Z');
    expect(row.spentMicrocents).toBe(0n);
    expect(row.generationCount).toBe(0);

    // The upsert key MUST use the truncated date.
    const upsertCall = aiSpendBucketDelegate.upsert.mock.calls[0]![0] as {
      where: { merchantId_date: { merchantId: string; date: Date } };
      update: Record<string, unknown>;
    };
    expect(upsertCall.where.merchantId_date.merchantId).toBe('m_1');
    expect(upsertCall.where.merchantId_date.date.toISOString()).toBe(
      '2026-06-15T00:00:00.000Z',
    );
    // Update branch is empty — we don't touch counters on an idempotent ensure.
    expect(upsertCall.update).toEqual({});
  });

  it('returns the existing row id when a bucket already exists for the day', async () => {
    const existingDate = new Date('2026-06-15T00:00:00.000Z');
    const { prisma, state, aiSpendBucketDelegate } = makeMockPrisma({
      rows: [
        {
          id: 'bucket_existing',
          merchantId: 'm_1',
          date: existingDate,
          spentMicrocents: 1500n,
          generationCount: 7,
        },
      ],
      nextId: 2,
    });
    const repo = new AiSpendBucketRepository(prisma);

    // Same calendar day, different time-of-day → MUST hit existing row.
    const result = await repo.getOrCreateForDay({
      merchantId: 'm_1',
      date: new Date('2026-06-15T18:00:00.000Z'),
    });

    expect(result).toEqual({ bucketId: 'bucket_existing' });
    expect(state.rows).toHaveLength(1);
    // Counters untouched on the idempotent ensure.
    expect(state.rows[0]!.spentMicrocents).toBe(1500n);
    expect(state.rows[0]!.generationCount).toBe(7);
    // Update branch is empty even on hit.
    const upsertCall = aiSpendBucketDelegate.upsert.mock.calls[0]![0] as {
      update: Record<string, unknown>;
    };
    expect(upsertCall.update).toEqual({});
  });

  it('uses the passed-in tx when provided', async () => {
    const { prisma: defaultPrisma } = makeMockPrisma();
    const tx = makeMockPrisma();
    const repo = new AiSpendBucketRepository(defaultPrisma);

    await repo.getOrCreateForDay(
      { merchantId: 'm_1', date: new Date('2026-06-15T12:00:00Z') },
      tx.prisma as never,
    );

    expect(tx.aiSpendBucketDelegate.upsert.mock.calls).toHaveLength(1);
    expect(
      (defaultPrisma.aiSpendBucket as unknown as { upsert: { mock: { calls: unknown[] } } })
        .upsert.mock.calls,
    ).toHaveLength(0);
  });
});

// ===========================================================================
// incrementSpend
// ===========================================================================

describe('AiSpendBucketRepository.incrementSpend', () => {
  it('creates a new bucket with deltaMicrocents + generationCount=1 on first call', async () => {
    const { prisma, state, aiSpendBucketDelegate } = makeMockPrisma();
    const repo = new AiSpendBucketRepository(prisma);

    await repo.incrementSpend({
      merchantId: 'm_1',
      date: new Date('2026-06-15T14:23:45.123Z'),
      deltaMicrocents: 4_620n,
    });

    expect(state.rows).toHaveLength(1);
    const row = state.rows[0]!;
    expect(row.merchantId).toBe('m_1');
    expect(row.date.toISOString()).toBe('2026-06-15T00:00:00.000Z');
    expect(row.spentMicrocents).toBe(4_620n);
    expect(row.generationCount).toBe(1);

    // The create payload carried the initial values (not increment operators).
    const upsertCall = aiSpendBucketDelegate.upsert.mock.calls[0]![0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(upsertCall.create.spentMicrocents).toBe(4_620n);
    expect(upsertCall.create.generationCount).toBe(1);
  });

  it('increments existing bucket spentMicrocents + generationCount on subsequent calls', async () => {
    const { prisma, state, aiSpendBucketDelegate } = makeMockPrisma({
      rows: [
        {
          id: 'bucket_1',
          merchantId: 'm_1',
          date: new Date('2026-06-15T00:00:00.000Z'),
          spentMicrocents: 4_620n,
          generationCount: 1,
        },
      ],
      nextId: 2,
    });
    const repo = new AiSpendBucketRepository(prisma);

    await repo.incrementSpend({
      merchantId: 'm_1',
      date: new Date('2026-06-15T16:00:00Z'), // Same UTC day, different time
      deltaMicrocents: 2_310n,
    });

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]!.spentMicrocents).toBe(6_930n);  // 4620 + 2310
    expect(state.rows[0]!.generationCount).toBe(2);

    // Verify the update branch uses {increment} operators (the atomic
    // path that maps to UPDATE spentMicrocents = spentMicrocents + N).
    const upsertCall = aiSpendBucketDelegate.upsert.mock.calls[0]![0] as {
      update: Record<string, unknown>;
    };
    expect(upsertCall.update.spentMicrocents).toEqual({ increment: 2_310n });
    expect(upsertCall.update.generationCount).toEqual({ increment: 1 });
  });

  it('preserves BigInt precision on deltaMicrocents (BigInt boundary lock)', async () => {
    const { prisma, state, aiSpendBucketDelegate } = makeMockPrisma();
    const repo = new AiSpendBucketRepository(prisma);

    // Value larger than Number.MAX_SAFE_INTEGER (2^53 - 1 = 9007199254740991).
    const bigDelta = 9_007_199_254_740_992n + 5n;
    await repo.incrementSpend({
      merchantId: 'm_1',
      date: new Date('2026-06-15T12:00:00Z'),
      deltaMicrocents: bigDelta,
    });

    const row = state.rows[0]!;
    expect(row.spentMicrocents).toBe(bigDelta);
    expect(typeof row.spentMicrocents).toBe('bigint');

    const upsertCall = aiSpendBucketDelegate.upsert.mock.calls[0]![0] as {
      create: Record<string, unknown>;
    };
    expect(upsertCall.create.spentMicrocents).toBe(bigDelta);
    expect(typeof upsertCall.create.spentMicrocents).toBe('bigint');
  });

  it('normalizes date to UTC midnight in the upsert key', async () => {
    const { prisma, aiSpendBucketDelegate } = makeMockPrisma();
    const repo = new AiSpendBucketRepository(prisma);

    // 23:59:59 of one day must NOT spill into the next UTC day.
    await repo.incrementSpend({
      merchantId: 'm_1',
      date: new Date('2026-06-15T23:59:59.999Z'),
      deltaMicrocents: 100n,
    });

    const upsertCall = aiSpendBucketDelegate.upsert.mock.calls[0]![0] as {
      where: { merchantId_date: { merchantId: string; date: Date } };
    };
    expect(upsertCall.where.merchantId_date.date.toISOString()).toBe(
      '2026-06-15T00:00:00.000Z',
    );
  });

  it('uses the passed-in tx (joins AI Worker completion three-write tx)', async () => {
    const { prisma: defaultPrisma } = makeMockPrisma();
    const tx = makeMockPrisma();
    const repo = new AiSpendBucketRepository(defaultPrisma);

    await repo.incrementSpend(
      { merchantId: 'm_1', date: new Date('2026-06-15T12:00:00Z'), deltaMicrocents: 100n },
      tx.prisma as never,
    );

    expect(tx.aiSpendBucketDelegate.upsert.mock.calls).toHaveLength(1);
    expect(
      (defaultPrisma.aiSpendBucket as unknown as { upsert: { mock: { calls: unknown[] } } })
        .upsert.mock.calls,
    ).toHaveLength(0);
  });
});

// ===========================================================================
// sumMonthSpend
// ===========================================================================

describe('AiSpendBucketRepository.sumMonthSpend', () => {
  it('sums spentMicrocents across all buckets in the calendar month of asOf', async () => {
    const { prisma } = makeMockPrisma({
      rows: [
        // June 2026 — IN window
        { id: 'b1', merchantId: 'm_1', date: new Date('2026-06-01T00:00:00Z'), spentMicrocents: 1_000n, generationCount: 1 },
        { id: 'b2', merchantId: 'm_1', date: new Date('2026-06-10T00:00:00Z'), spentMicrocents: 2_500n, generationCount: 3 },
        { id: 'b3', merchantId: 'm_1', date: new Date('2026-06-15T00:00:00Z'), spentMicrocents: 750n, generationCount: 2 },
        // May 2026 — OUT (before window)
        { id: 'b4', merchantId: 'm_1', date: new Date('2026-05-31T00:00:00Z'), spentMicrocents: 9_999n, generationCount: 5 },
        // Different merchant — OUT (different tenant)
        { id: 'b5', merchantId: 'm_2', date: new Date('2026-06-15T00:00:00Z'), spentMicrocents: 8_888n, generationCount: 7 },
      ],
      nextId: 6,
    });
    const repo = new AiSpendBucketRepository(prisma);

    const result = await repo.sumMonthSpend({
      merchantId: 'm_1',
      asOf: new Date('2026-06-15T14:00:00Z'),
    });

    expect(result).toBe(4_250n); // 1000 + 2500 + 750
    expect(typeof result).toBe('bigint');
  });

  it('returns 0n when no rows match (no buckets exist yet for this merchant)', async () => {
    const { prisma } = makeMockPrisma();
    const repo = new AiSpendBucketRepository(prisma);

    const result = await repo.sumMonthSpend({
      merchantId: 'm_1',
      asOf: new Date('2026-06-15T12:00:00Z'),
    });

    expect(result).toBe(0n);
  });

  it('returns 0n when rows exist for other months but not the current one', async () => {
    const { prisma } = makeMockPrisma({
      rows: [
        { id: 'b1', merchantId: 'm_1', date: new Date('2026-05-31T00:00:00Z'), spentMicrocents: 9_999n, generationCount: 5 },
      ],
      nextId: 2,
    });
    const repo = new AiSpendBucketRepository(prisma);

    const result = await repo.sumMonthSpend({
      merchantId: 'm_1',
      asOf: new Date('2026-06-15T12:00:00Z'),
    });

    expect(result).toBe(0n);
  });

  it('uses UTC month start as the date.gte filter (boundary regression lock)', async () => {
    const { prisma, aiSpendBucketDelegate } = makeMockPrisma();
    const repo = new AiSpendBucketRepository(prisma);

    await repo.sumMonthSpend({
      merchantId: 'm_1',
      asOf: new Date('2026-06-15T14:23:45.123Z'),
    });

    const aggregateCall = aiSpendBucketDelegate.aggregate.mock.calls[0]![0] as {
      where: { merchantId: string; date: { gte: Date } };
      _sum: Record<string, boolean>;
    };
    // The gte boundary MUST be the UTC midnight of the first day of June 2026.
    expect(aggregateCall.where.date.gte.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(aggregateCall.where.merchantId).toBe('m_1');
    expect(aggregateCall._sum.spentMicrocents).toBe(true);
  });

  it('handles January correctly (Date.UTC zero-indexed month edge case)', async () => {
    const { prisma, aiSpendBucketDelegate } = makeMockPrisma();
    const repo = new AiSpendBucketRepository(prisma);

    await repo.sumMonthSpend({
      merchantId: 'm_1',
      asOf: new Date('2026-01-15T12:00:00Z'),
    });

    const aggregateCall = aiSpendBucketDelegate.aggregate.mock.calls[0]![0] as {
      where: { date: { gte: Date } };
    };
    expect(aggregateCall.where.date.gte.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('handles December correctly (no cross-year spill)', async () => {
    const { prisma, aiSpendBucketDelegate } = makeMockPrisma();
    const repo = new AiSpendBucketRepository(prisma);

    await repo.sumMonthSpend({
      merchantId: 'm_1',
      asOf: new Date('2026-12-31T23:59:59.999Z'),
    });

    const aggregateCall = aiSpendBucketDelegate.aggregate.mock.calls[0]![0] as {
      where: { date: { gte: Date } };
    };
    expect(aggregateCall.where.date.gte.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it('preserves BigInt precision in the aggregated sum', async () => {
    const big = 9_007_199_254_740_992n; // > Number.MAX_SAFE_INTEGER
    const { prisma } = makeMockPrisma({
      rows: [
        { id: 'b1', merchantId: 'm_1', date: new Date('2026-06-01T00:00:00Z'), spentMicrocents: big, generationCount: 1 },
        { id: 'b2', merchantId: 'm_1', date: new Date('2026-06-10T00:00:00Z'), spentMicrocents: big, generationCount: 1 },
      ],
      nextId: 3,
    });
    const repo = new AiSpendBucketRepository(prisma);

    const result = await repo.sumMonthSpend({
      merchantId: 'm_1',
      asOf: new Date('2026-06-15T00:00:00Z'),
    });

    expect(result).toBe(big * 2n);
    expect(typeof result).toBe('bigint');
  });

  it('uses the passed-in tx when provided', async () => {
    const { prisma: defaultPrisma } = makeMockPrisma();
    const tx = makeMockPrisma({
      rows: [
        { id: 'b1', merchantId: 'm_1', date: new Date('2026-06-15T00:00:00Z'), spentMicrocents: 555n, generationCount: 1 },
      ],
      nextId: 2,
    });
    const repo = new AiSpendBucketRepository(defaultPrisma);

    const result = await repo.sumMonthSpend(
      { merchantId: 'm_1', asOf: new Date('2026-06-15T00:00:00Z') },
      tx.prisma as never,
    );
    expect(result).toBe(555n);

    expect(tx.aiSpendBucketDelegate.aggregate.mock.calls).toHaveLength(1);
    expect(
      (defaultPrisma.aiSpendBucket as unknown as { aggregate: { mock: { calls: unknown[] } } })
        .aggregate.mock.calls,
    ).toHaveLength(0);
  });
});
