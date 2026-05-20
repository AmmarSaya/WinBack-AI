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
      withTenantScope({ merchantId: 'other-merchant' }, async () =>
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
      withTenantScope({ merchantId: 'other-merchant' }, async () =>
        repo.upsertScore({
          ...baseArgs,
          tx: tx as unknown as Prisma.TransactionClient,
        }),
      ),
    ).rejects.toThrow(TenantScopeError);
  });
});
