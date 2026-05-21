import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { WinbackPrisma } from '../src/client.js';
import { CustomerScoreRepository } from '../src/repositories/customer-score.repository.js';
import { withSystemScope, withTenantScope } from '../src/tenant-scope.js';
import { TenantScopeError } from '../src/errors.js';

/**
 * Unit tests for CustomerScoreRepository.readCohort + upsertScore against
 * a mocked Prisma transaction client.  Real-DB coverage in the batch 5
 * drainer integration harness.
 *
 * Tests wrap each operation in withSystemScope (or withTenantScope) so
 * assertScopeMatchesMerchant passes.  The scope-assertion behavior itself
 * is covered in tenant-scope.test.ts; here we exercise the business logic
 * on top.
 */

const MERCHANT_ID = 'm_test';
const CUSTOMER_ID = 'cust_local_1';
const SCORE_ID = 'score_local_1';

interface MockTx {
  $queryRaw: Mock;
  customerScore: {
    findUnique: Mock;
    upsert: Mock;
  };
}

function makeTx(): MockTx {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    customerScore: {
      findUnique: vi.fn(),
      upsert: vi.fn().mockResolvedValue({ id: SCORE_ID }),
    },
  };
}

describe('CustomerScoreRepository.readCohort', () => {
  let repo: CustomerScoreRepository;
  let tx: MockTx;
  const NOW = new Date('2026-05-20T12:00:00.000Z');

  beforeEach(() => {
    repo = new CustomerScoreRepository({} as WinbackPrisma);
    tx = makeTx();
  });

  it('returns an empty array when no customers are in the scorable cohort', async () => {
    tx.$queryRaw.mockResolvedValue([]);
    const result = await withSystemScope('test.read_cohort', async () =>
      repo.readCohort({
        merchantId: MERCHANT_ID,
        now: NOW,
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    expect(result).toEqual([]);
  });

  it('returns BigInt mCents on cohort rows (BIGINT column → bigint at the boundary)', async () => {
    tx.$queryRaw.mockResolvedValue([
      { customerId: 'c1', rDays: 5, fCount: 3, mCents: 19995n },
      { customerId: 'c2', rDays: 120, fCount: 1, mCents: 4999n },
    ]);
    const result = await withSystemScope('test.read_cohort', async () =>
      repo.readCohort({
        merchantId: MERCHANT_ID,
        now: NOW,
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    expect(result).toHaveLength(2);
    expect(typeof result[0].mCents).toBe('bigint');
    expect(result[0].mCents).toBe(19995n);
    expect(result[1].mCents).toBe(4999n);
  });

  it('uses args.tx (NOT this.prisma) for the cohort read — TX invariant', async () => {
    tx.$queryRaw.mockResolvedValue([]);
    await withSystemScope('test.read_cohort', async () =>
      repo.readCohort({
        merchantId: MERCHANT_ID,
        now: NOW,
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('binds now AND windowStart (now - 365d) as separate SQL parameters', async () => {
    tx.$queryRaw.mockResolvedValue([]);
    await withSystemScope('test.read_cohort', async () =>
      repo.readCohort({
        merchantId: MERCHANT_ID,
        now: NOW,
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    // Prisma.sql template binds JS values as `values[]` on the Sql object.
    // The order in the SQL is [now, merchantId, windowStart].
    const sqlArg = tx.$queryRaw.mock.calls[0][0] as { values: unknown[] };
    expect(sqlArg.values).toContain(MERCHANT_ID);
    // Window start = NOW - 365 days
    const expectedWindowStart = new Date(NOW.getTime() - 365 * 86400000);
    expect(sqlArg.values).toContainEqual(NOW);
    expect(sqlArg.values).toContainEqual(expectedWindowStart);
  });

  it('throws TenantScopeError when active scope does not match merchantId', async () => {
    await expect(
      withTenantScope('other-merchant', async () =>
        repo.readCohort({
          merchantId: MERCHANT_ID,
          now: NOW,
          tx: tx as unknown as Prisma.TransactionClient,
        }),
      ),
    ).rejects.toThrow(TenantScopeError);
  });
});

describe('CustomerScoreRepository.upsertScore', () => {
  let repo: CustomerScoreRepository;
  let tx: MockTx;
  const COMPUTED_AT = new Date('2026-05-20T12:00:00.000Z');

  const baseArgs = {
    merchantId: MERCHANT_ID,
    customerId: CUSTOMER_ID,
    rDays: 12,
    fCount: 4,
    mCents: 49995n,
    currency: 'USD',
    rQuintile: 5 as number | null,
    fQuintile: 4 as number | null,
    mQuintile: 4 as number | null,
    churnRiskScore: 0.13333333333333333,
    computedAt: COMPUTED_AT,
  };

  beforeEach(() => {
    repo = new CustomerScoreRepository({} as WinbackPrisma);
    tx = makeTx();
  });

  it('new score → isNewScore=true, customerScoreId returned', async () => {
    tx.customerScore.findUnique.mockResolvedValue(null);
    const result = await withSystemScope('test.upsert_score', async () =>
      repo.upsertScore({
        ...baseArgs,
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    expect(result.isNewScore).toBe(true);
    expect(result.customerScoreId).toBe(SCORE_ID);
  });

  it('existing score → isNewScore=false (idempotent recompute)', async () => {
    tx.customerScore.findUnique.mockResolvedValue({ id: SCORE_ID });
    const result = await withSystemScope('test.upsert_score', async () =>
      repo.upsertScore({
        ...baseArgs,
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    expect(result.isNewScore).toBe(false);
  });

  it('writes both create and update branches with identical sharedFields', async () => {
    tx.customerScore.findUnique.mockResolvedValue(null);
    await withSystemScope('test.upsert_score', async () =>
      repo.upsertScore({
        ...baseArgs,
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    const upsertCall = tx.customerScore.upsert.mock.calls[0][0];
    expect(upsertCall.create).toMatchObject({
      merchantId: MERCHANT_ID,
      customerId: CUSTOMER_ID,
      rDays: 12,
      fCount: 4,
      mCents: 49995n,
      currency: 'USD',
      rQuintile: 5,
      fQuintile: 4,
      mQuintile: 4,
      churnRiskScore: baseArgs.churnRiskScore,
      computedAt: COMPUTED_AT,
    });
    expect(upsertCall.update).toMatchObject({
      rDays: 12,
      fCount: 4,
      mCents: 49995n,
      currency: 'USD',
      rQuintile: 5,
      fQuintile: 4,
      mQuintile: 4,
      churnRiskScore: baseArgs.churnRiskScore,
      computedAt: COMPUTED_AT,
    });
  });

  it('null quintiles + null churnRiskScore pass through (insufficient_data / lurker case)', async () => {
    tx.customerScore.findUnique.mockResolvedValue(null);
    await withSystemScope('test.upsert_score', async () =>
      repo.upsertScore({
        ...baseArgs,
        rQuintile: null,
        fQuintile: null,
        mQuintile: null,
        churnRiskScore: null,
        fCount: 0,
        mCents: 0n,
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    const upsertCall = tx.customerScore.upsert.mock.calls[0][0];
    expect(upsertCall.create.rQuintile).toBeNull();
    expect(upsertCall.create.fQuintile).toBeNull();
    expect(upsertCall.create.mQuintile).toBeNull();
    expect(upsertCall.create.churnRiskScore).toBeNull();
    expect(upsertCall.create.mCents).toBe(0n);
  });

  it('upsert keyed on customerId (single-column @unique, not the composite)', async () => {
    tx.customerScore.findUnique.mockResolvedValue(null);
    await withSystemScope('test.upsert_score', async () =>
      repo.upsertScore({
        ...baseArgs,
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    expect(tx.customerScore.upsert.mock.calls[0][0].where).toEqual({ customerId: CUSTOMER_ID });
    expect(tx.customerScore.findUnique.mock.calls[0][0].where).toEqual({ customerId: CUSTOMER_ID });
  });

  it('uses args.tx for both the pre-write findUnique AND the upsert — TX invariant', async () => {
    tx.customerScore.findUnique.mockResolvedValue(null);
    await withSystemScope('test.upsert_score', async () =>
      repo.upsertScore({
        ...baseArgs,
        tx: tx as unknown as Prisma.TransactionClient,
      }),
    );
    expect(tx.customerScore.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.customerScore.upsert).toHaveBeenCalledTimes(1);
  });

  it('throws TenantScopeError when active scope does not match merchantId', async () => {
    await expect(
      withTenantScope('other-merchant', async () =>
        repo.upsertScore({
          ...baseArgs,
          tx: tx as unknown as Prisma.TransactionClient,
        }),
      ),
    ).rejects.toThrow(TenantScopeError);
  });
});

// ===========================================================================
// Read surface — Epic E UI session
// ===========================================================================

interface MockPrismaForReads {
  customer: { groupBy: Mock };
  customerScore: { findMany: Mock };
}

function makePrisma(): MockPrismaForReads {
  return {
    customer: { groupBy: vi.fn() },
    customerScore: { findMany: vi.fn() },
  };
}

describe('CustomerScoreRepository.getStateBandCounts', () => {
  let prisma: MockPrismaForReads;
  let repo: CustomerScoreRepository;

  beforeEach(() => {
    prisma = makePrisma();
    repo = new CustomerScoreRepository(prisma as unknown as WinbackPrisma);
  });

  it('empty merchant → all six bands return 0', async () => {
    prisma.customer.groupBy.mockResolvedValue([]);
    const counts = await withSystemScope('test.state_band_counts', async () =>
      repo.getStateBandCounts(MERCHANT_ID),
    );
    expect(counts).toEqual({
      active: 0,
      warm: 0,
      at_risk: 0,
      dormant: 0,
      lost: 0,
      insufficient_data: 0,
    });
  });

  it('mixed bands → returns exact counts; missing bands zero-fill', async () => {
    prisma.customer.groupBy.mockResolvedValue([
      { state: 'active', _count: { _all: 12 } },
      { state: 'at_risk', _count: { _all: 5 } },
      { state: 'lost', _count: { _all: 3 } },
    ]);
    const counts = await withSystemScope('test.state_band_counts', async () =>
      repo.getStateBandCounts(MERCHANT_ID),
    );
    expect(counts).toEqual({
      active: 12,
      warm: 0,
      at_risk: 5,
      dormant: 0,
      lost: 3,
      insufficient_data: 0,
    });
  });

  it('all six bands populated → returns each value', async () => {
    prisma.customer.groupBy.mockResolvedValue([
      { state: 'active', _count: { _all: 100 } },
      { state: 'warm', _count: { _all: 50 } },
      { state: 'at_risk', _count: { _all: 20 } },
      { state: 'dormant', _count: { _all: 8 } },
      { state: 'lost', _count: { _all: 3 } },
      { state: 'insufficient_data', _count: { _all: 1 } },
    ]);
    const counts = await withSystemScope('test.state_band_counts', async () =>
      repo.getStateBandCounts(MERCHANT_ID),
    );
    expect(counts).toEqual({
      active: 100,
      warm: 50,
      at_risk: 20,
      dormant: 8,
      lost: 3,
      insufficient_data: 1,
    });
  });

  it('passes merchantId in where clause to Prisma', async () => {
    prisma.customer.groupBy.mockResolvedValue([]);
    await withSystemScope('test.state_band_counts', async () =>
      repo.getStateBandCounts(MERCHANT_ID),
    );
    expect(prisma.customer.groupBy.mock.calls[0]![0]).toMatchObject({
      by: ['state'],
      where: { merchantId: MERCHANT_ID },
      _count: { _all: true },
    });
  });

  it('throws TenantScopeError when active scope does not match merchantId', async () => {
    await expect(
      withTenantScope('other-merchant', async () => repo.getStateBandCounts(MERCHANT_ID)),
    ).rejects.toThrow(TenantScopeError);
  });
});

describe('CustomerScoreRepository.listWithCustomer', () => {
  let prisma: MockPrismaForReads;
  let repo: CustomerScoreRepository;

  function makeJoinedRow(args: {
    id: string;
    customerId: string;
    churnRiskScore?: number | null;
    email?: string | null;
    state?: string;
  }) {
    return {
      id: args.id,
      customerId: args.customerId,
      rDays: 30,
      fCount: 2,
      mCents: 19_995n,
      currency: 'USD',
      rQuintile: 3,
      fQuintile: 3,
      mQuintile: 3,
      // `??` would clobber an explicit `null` (which is exactly the
       // lurker / insufficient_data case we're testing).  Distinguish
       // "absent" (use default) from "explicit null" (use null).
      churnRiskScore: args.churnRiskScore === undefined ? 0.4 : args.churnRiskScore,
      computedAt: new Date('2026-05-20T00:00:00Z'),
      customer: {
        id: args.customerId,
        email: args.email ?? 'jane@example.com',
        firstName: 'Jane',
        lastName: 'Doe',
        shopifyCustomerId: 'gid://shopify/Customer/12345',
        state: args.state ?? 'active',
        lastOrderAt: new Date('2026-05-15T00:00:00Z'),
      },
    };
  }

  beforeEach(() => {
    prisma = makePrisma();
    repo = new CustomerScoreRepository(prisma as unknown as WinbackPrisma);
  });

  it('empty result → rows=[], nextCursor=null', async () => {
    prisma.customerScore.findMany.mockResolvedValue([]);
    const result = await withSystemScope('test.list_scores', async () =>
      repo.listWithCustomer({ merchantId: MERCHANT_ID, cursor: null, limit: 50 }),
    );
    expect(result.rows).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('result < limit → nextCursor=null (no more pages)', async () => {
    prisma.customerScore.findMany.mockResolvedValue([
      makeJoinedRow({ id: 's1', customerId: 'c1' }),
      makeJoinedRow({ id: 's2', customerId: 'c2' }),
    ]);
    const result = await withSystemScope('test.list_scores', async () =>
      repo.listWithCustomer({ merchantId: MERCHANT_ID, cursor: null, limit: 50 }),
    );
    expect(result.rows).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it('result = limit+1 → trims to limit and returns last-trimmed id as nextCursor', async () => {
    const rows = Array.from({ length: 51 }, (_, i) =>
      makeJoinedRow({ id: `s${i}`, customerId: `c${i}` }),
    );
    prisma.customerScore.findMany.mockResolvedValue(rows);
    const result = await withSystemScope('test.list_scores', async () =>
      repo.listWithCustomer({ merchantId: MERCHANT_ID, cursor: null, limit: 50 }),
    );
    expect(result.rows).toHaveLength(50);
    // nextCursor is the id of the LAST row in the trimmed page (s49),
    // NOT the id of the extra row (s50) — that's what the caller passes
    // back on the next request, and Prisma's cursor+skip:1 advances past it.
    expect(result.nextCursor).toBe('s49');
  });

  it('cursor provided → passes { cursor: { id }, skip: 1 } to Prisma', async () => {
    prisma.customerScore.findMany.mockResolvedValue([]);
    await withSystemScope('test.list_scores', async () =>
      repo.listWithCustomer({
        merchantId: MERCHANT_ID,
        cursor: 'cursor_id_from_prev_page',
        limit: 50,
      }),
    );
    const args = prisma.customerScore.findMany.mock.calls[0]![0];
    expect(args.cursor).toEqual({ id: 'cursor_id_from_prev_page' });
    expect(args.skip).toBe(1);
  });

  it('first page (cursor=null) → cursor + skip omitted from Prisma args', async () => {
    prisma.customerScore.findMany.mockResolvedValue([]);
    await withSystemScope('test.list_scores', async () =>
      repo.listWithCustomer({ merchantId: MERCHANT_ID, cursor: null, limit: 50 }),
    );
    const args = prisma.customerScore.findMany.mock.calls[0]![0];
    expect(args.cursor).toBeUndefined();
    // skip may be undefined or absent — both are equivalent semantically.
    expect(args.skip ?? 0).toBe(0);
  });

  it('orderBy contract is [churnRiskScore desc nulls last, customer.email asc, id asc]', async () => {
    prisma.customerScore.findMany.mockResolvedValue([]);
    await withSystemScope('test.list_scores', async () =>
      repo.listWithCustomer({ merchantId: MERCHANT_ID, cursor: null, limit: 50 }),
    );
    const args = prisma.customerScore.findMany.mock.calls[0]![0];
    expect(args.orderBy).toEqual([
      { churnRiskScore: { sort: 'desc', nulls: 'last' } },
      { customer: { email: 'asc' } },
      { id: 'asc' },
    ]);
  });

  it('filterStates non-empty → passes state: { in: ... } via customer relation filter', async () => {
    prisma.customerScore.findMany.mockResolvedValue([]);
    await withSystemScope('test.list_scores', async () =>
      repo.listWithCustomer({
        merchantId: MERCHANT_ID,
        cursor: null,
        limit: 50,
        filterStates: ['at_risk', 'dormant'],
      }),
    );
    const args = prisma.customerScore.findMany.mock.calls[0]![0];
    expect(args.where.customer.state).toEqual({ in: ['at_risk', 'dormant'] });
  });

  it('filterStates empty array → no state filter applied (treated as "all")', async () => {
    prisma.customerScore.findMany.mockResolvedValue([]);
    await withSystemScope('test.list_scores', async () =>
      repo.listWithCustomer({
        merchantId: MERCHANT_ID,
        cursor: null,
        limit: 50,
        filterStates: [],
      }),
    );
    const args = prisma.customerScore.findMany.mock.calls[0]![0];
    expect(args.where.customer.state).toBeUndefined();
  });

  it('filterStates undefined → no state filter applied', async () => {
    prisma.customerScore.findMany.mockResolvedValue([]);
    await withSystemScope('test.list_scores', async () =>
      repo.listWithCustomer({ merchantId: MERCHANT_ID, cursor: null, limit: 50 }),
    );
    const args = prisma.customerScore.findMany.mock.calls[0]![0];
    expect(args.where.customer.state).toBeUndefined();
  });

  it('always passes customer.deletedAt: null (excludes soft-deleted customers)', async () => {
    prisma.customerScore.findMany.mockResolvedValue([]);
    await withSystemScope('test.list_scores', async () =>
      repo.listWithCustomer({ merchantId: MERCHANT_ID, cursor: null, limit: 50 }),
    );
    const args = prisma.customerScore.findMany.mock.calls[0]![0];
    expect(args.where.customer.deletedAt).toBeNull();
  });

  it('passes merchantId in top-level where', async () => {
    prisma.customerScore.findMany.mockResolvedValue([]);
    await withSystemScope('test.list_scores', async () =>
      repo.listWithCustomer({ merchantId: MERCHANT_ID, cursor: null, limit: 50 }),
    );
    const args = prisma.customerScore.findMany.mock.calls[0]![0];
    expect(args.where.merchantId).toBe(MERCHANT_ID);
  });

  it('take = limit + 1 (fetches one extra for next-page detection)', async () => {
    prisma.customerScore.findMany.mockResolvedValue([]);
    await withSystemScope('test.list_scores', async () =>
      repo.listWithCustomer({ merchantId: MERCHANT_ID, cursor: null, limit: 50 }),
    );
    expect(prisma.customerScore.findMany.mock.calls[0]![0].take).toBe(51);
  });

  it('flattens Customer + CustomerScore into a single ListedCustomerScore row', async () => {
    prisma.customerScore.findMany.mockResolvedValue([
      makeJoinedRow({
        id: 's1',
        customerId: 'c1',
        churnRiskScore: 0.65,
        email: 'top@example.com',
        state: 'at_risk',
      }),
    ]);
    const result = await withSystemScope('test.list_scores', async () =>
      repo.listWithCustomer({ merchantId: MERCHANT_ID, cursor: null, limit: 50 }),
    );
    expect(result.rows[0]).toEqual({
      customerScoreId: 's1',
      customerId: 'c1',
      shopifyCustomerId: 'gid://shopify/Customer/12345',
      email: 'top@example.com',
      firstName: 'Jane',
      lastName: 'Doe',
      state: 'at_risk',
      lastOrderAt: new Date('2026-05-15T00:00:00Z'),
      rDays: 30,
      fCount: 2,
      mCents: 19_995n,
      currency: 'USD',
      rQuintile: 3,
      fQuintile: 3,
      mQuintile: 3,
      churnRiskScore: 0.65,
      computedAt: new Date('2026-05-20T00:00:00Z'),
    });
  });

  it('preserves null churnRiskScore in the row (lurker / insufficient_data passthrough)', async () => {
    prisma.customerScore.findMany.mockResolvedValue([
      makeJoinedRow({ id: 's1', customerId: 'c1', churnRiskScore: null }),
    ]);
    const result = await withSystemScope('test.list_scores', async () =>
      repo.listWithCustomer({ merchantId: MERCHANT_ID, cursor: null, limit: 50 }),
    );
    expect(result.rows[0]!.churnRiskScore).toBeNull();
  });

  it('throws TenantScopeError when active scope does not match merchantId', async () => {
    await expect(
      withTenantScope('other-merchant', async () =>
        repo.listWithCustomer({ merchantId: MERCHANT_ID, cursor: null, limit: 50 }),
      ),
    ).rejects.toThrow(TenantScopeError);
  });
});
