import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// Q-H1 closure: capture warn-log emissions for the un-enriched-currency
// observability assertion. The service's module-scope `getLogger` call
// resolves at import time; the hoisted mock below replaces it.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock('@winback/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  }),
}));

import type { WinbackPrisma } from '../src/client.js';
import { TenantScopeError } from '../src/errors.js';
import { AuditLogRepository } from '../src/repositories/audit-log.repository.js';
import { CustomerScoreRepository } from '../src/repositories/customer-score.repository.js';
import { CustomerScoreService } from '../src/services/customer-score.service.js';
import { withSystemScope, withTenantScope } from '../src/tenant-scope.js';

/**
 * Unit tests for CustomerScoreService.recompute with mocked
 * Prisma + mocked repositories.  Real-DB coverage lands in batch 5 via
 * the drainer integration harness.
 *
 * Key invariants under test (per user audit flag from batch-3 kickoff):
 *   - The lurker branch fires when the cohort aggregation does NOT contain
 *     the customer's row.  Uses account-age R.  Null quintiles.  Never a
 *     fallthrough to the scorable path with wrong values.
 *   - The scorable branch fires when the cohort aggregation DOES contain
 *     the customer's row.  Uses cohort R/F/M directly.
 *   - State change → 4 writes in the same tx.  No state change → 1 write.
 *   - Customer absent (deleted/race) → skipped result (no throw).
 */

const MERCHANT_ID = 'm_test';
const CUSTOMER_ID = 'cust_local_1';
const SCORE_ID = 'score_local_1';
const SHOP = 'foo.myshopify.com';
const SHOP_CUSTOMER_GID = 'gid://shopify/Customer/12345';
const NOW = new Date('2026-05-20T12:00:00.000Z');

interface MockTx {
  $queryRaw: Mock;
  // `findMany` + `merchant.update` added for the A1b bulkRescore path.
  customer: { findUnique: Mock; update: Mock; findMany: Mock };
  merchant: { findUnique: Mock; update: Mock };
  outboxEvent: { create: Mock };
  customerScore: { findUnique: Mock; upsert: Mock };
  auditLog: { create: Mock };
}

function makeTx(): MockTx {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    customer: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({ id: CUSTOMER_ID }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    merchant: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({ id: MERCHANT_ID }),
    },
    outboxEvent: { create: vi.fn().mockResolvedValue({ id: 'oe_1' }) },
    customerScore: {
      findUnique: vi.fn(),
      upsert: vi.fn().mockResolvedValue({ id: SCORE_ID }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'al_1' }) },
  };
}

function makeService(): {
  service: CustomerScoreService;
  customerScoreRepo: CustomerScoreRepository;
  auditLogRepo: AuditLogRepository;
} {
  const prisma = {} as WinbackPrisma;
  const customerScoreRepo = new CustomerScoreRepository(prisma);
  const auditLogRepo = new AuditLogRepository(prisma);
  return {
    service: new CustomerScoreService(customerScoreRepo, auditLogRepo),
    customerScoreRepo,
    auditLogRepo,
  };
}

function mockCustomerFound(tx: MockTx, overrides: Record<string, unknown> = {}): void {
  tx.customer.findUnique.mockResolvedValue({
    state: 'active',
    shopifyCustomerId: SHOP_CUSTOMER_GID,
    shopifyCreatedAt: new Date('2026-04-01T00:00:00.000Z'),
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    ...overrides,
  });
}

// Q-H1: mockMerchantFound now provides installedAt + shopDetailsFetchedAt
// so the service's un-enriched-currency WARN log can read them. Defaults
// model the happy path (enriched 1 minute after install).
function mockMerchantFound(
  tx: MockTx,
  currency: string | null = 'USD',
  installedAt: Date = new Date('2026-05-19T12:00:00.000Z'),
  shopDetailsFetchedAt: Date | null = new Date('2026-05-19T12:01:00.000Z'),
  // A1a: default to an INITIALIZED merchant so the existing emission-asserting
  // tests below keep firing the AuditLog + OutboxEvent. The suppression suite
  // passes `null` explicitly to exercise the first-pass gate.
  scoringInitializedAt: Date | null = new Date('2026-05-19T12:05:00.000Z'),
): void {
  tx.merchant.findUnique.mockResolvedValue({
    currency,
    shop: SHOP,
    installedAt,
    shopDetailsFetchedAt,
    scoringInitializedAt,
  });
}

/** Five-customer cohort spanning the full quintile range. */
function fullCohort(targetRowOverride?: Partial<{ rDays: number; fCount: number; mCents: bigint }>): unknown[] {
  return [
    {
      customerId: CUSTOMER_ID,
      rDays: targetRowOverride?.rDays ?? 5,
      fCount: targetRowOverride?.fCount ?? 10,
      mCents: targetRowOverride?.mCents ?? 100_000n,
    },
    { customerId: 'c2', rDays: 20, fCount: 7, mCents: 50_000n },
    { customerId: 'c3', rDays: 60, fCount: 4, mCents: 20_000n },
    { customerId: 'c4', rDays: 200, fCount: 2, mCents: 5_000n },
    { customerId: 'c5', rDays: 400, fCount: 1, mCents: 1_000n },
  ];
}

// ===========================================================================
// Skip + error paths
// ===========================================================================

describe('CustomerScoreService.recompute — skip + error paths', () => {
  let tx: MockTx;
  beforeEach(() => {
    tx = makeTx();
  });

  it('customer not found → returns skipped result (no throw, no writes)', async () => {
    const { service } = makeService();
    tx.customer.findUnique.mockResolvedValue(null);

    const result = await withTenantScope(MERCHANT_ID, async () =>
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    );

    expect(result.skipped).toBe('customer_not_found');
    expect(tx.customerScore.upsert).not.toHaveBeenCalled();
    expect(tx.customer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('merchant not found → throws (stale parent tx — defensive)', async () => {
    const { service } = makeService();
    mockCustomerFound(tx);
    tx.merchant.findUnique.mockResolvedValue(null);

    await expect(
      withTenantScope(MERCHANT_ID, async () =>
        service.recompute({
          merchantId: MERCHANT_ID,
          customerId: CUSTOMER_ID,
          tx: tx as unknown as Prisma.TransactionClient,
          now: NOW,
        }),
      ),
    ).rejects.toThrow(/merchant .* not found/);
  });

  it('throws TenantScopeError when active scope does not match merchantId', async () => {
    const { service } = makeService();
    await expect(
      withTenantScope('other-merchant', async () =>
        service.recompute({
          merchantId: MERCHANT_ID,
          customerId: CUSTOMER_ID,
          tx: tx as unknown as Prisma.TransactionClient,
          now: NOW,
        }),
      ),
    ).rejects.toThrow(TenantScopeError);
  });

  it('throws when called outside any scope', async () => {
    const { service } = makeService();
    await expect(
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    ).rejects.toThrow(TenantScopeError);
  });

  it('runs under withSystemScope (system passthrough → no merchantId check)', async () => {
    const { service } = makeService();
    mockCustomerFound(tx);
    mockMerchantFound(tx);
    tx.$queryRaw.mockResolvedValue(fullCohort());

    await withSystemScope('test.bulk_rescore', async () =>
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    );

    expect(tx.customerScore.upsert).toHaveBeenCalled();
  });
});

// ===========================================================================
// Scorable branch — happy paths
// ===========================================================================

describe('CustomerScoreService.recompute — scorable branch', () => {
  let tx: MockTx;
  beforeEach(() => {
    tx = makeTx();
  });

  it('full cohort, state change active→active stays no-op (same state — no audit/outbox)', async () => {
    const { service } = makeService();
    // Customer is at top of cohort (rDays=5, top-quintile everything → active).
    mockCustomerFound(tx, { state: 'active' });
    mockMerchantFound(tx);
    tx.$queryRaw.mockResolvedValue(fullCohort());

    const result = await withTenantScope(MERCHANT_ID, async () =>
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    );

    if (result.skipped !== null) throw new Error('expected applied result');
    expect(result.stateChanged).toBe(false);
    expect(result.previousState).toBe('active');
    expect(result.newState).toBe('active');
    expect(result.branchTaken).toBe('scorable');
    expect(tx.customer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    // Always upserts the score even on no state change (refreshes computedAt).
    expect(tx.customerScore.upsert).toHaveBeenCalledTimes(1);
  });

  it('state change active→warm → all four writes happen in tx', async () => {
    const { service } = makeService();
    // Set target's rDays to 60 (warm range), keep other customers spread.
    mockCustomerFound(tx, { state: 'active' });
    mockMerchantFound(tx);
    tx.$queryRaw.mockResolvedValue(fullCohort({ rDays: 60, fCount: 4, mCents: 20_000n }));

    const result = await withTenantScope(MERCHANT_ID, async () =>
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    );

    if (result.skipped !== null) throw new Error('expected applied result');
    expect(result.stateChanged).toBe(true);
    expect(result.newState).toBe('warm');
    expect(result.branchTaken).toBe('scorable');
    expect(tx.customer.update).toHaveBeenCalledWith({
      where: { id: CUSTOMER_ID },
      data: { state: 'warm' },
    });
    expect(tx.customerScore.upsert).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
  });

  it('quintiles and churn risk computed for top-of-cohort customer', async () => {
    const { service } = makeService();
    mockCustomerFound(tx, { state: 'lost' }); // force state change so outbox fires
    mockMerchantFound(tx);
    tx.$queryRaw.mockResolvedValue(fullCohort()); // target = c1, all top values

    const result = await withTenantScope(MERCHANT_ID, async () =>
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    );

    if (result.skipped !== null) throw new Error('expected applied result');
    expect(result.rQuintile).toBe(5);
    expect(result.fQuintile).toBe(5);
    expect(result.mQuintile).toBe(5);
    expect(result.churnRiskScore).toBe(0);
    expect(result.newState).toBe('active');
  });

  it('insufficient cohort (4 customers) → scorable customer gets null quintiles + insufficient_data', async () => {
    const { service } = makeService();
    mockCustomerFound(tx, { state: 'active' });
    mockMerchantFound(tx);
    tx.$queryRaw.mockResolvedValue(fullCohort().slice(0, 4)); // 4 customers — below threshold

    const result = await withTenantScope(MERCHANT_ID, async () =>
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    );

    if (result.skipped !== null) throw new Error('expected applied result');
    expect(result.newState).toBe('insufficient_data');
    expect(result.branchTaken).toBe('scorable');
    expect(result.rQuintile).toBeNull();
    expect(result.fQuintile).toBeNull();
    expect(result.mQuintile).toBeNull();
    expect(result.churnRiskScore).toBeNull();
    // Raw R/F/M still passed through.
    expect(result.rDays).toBe(5);
    expect(result.fCount).toBe(10);
    expect(result.mCents).toBe(100_000n);
  });
});

// ===========================================================================
// Lurker branch — explicit per user audit
// ===========================================================================

describe('CustomerScoreService.recompute — lurker branch (user audit focus)', () => {
  let tx: MockTx;
  beforeEach(() => {
    tx = makeTx();
  });

  it('lurker (cohort missing this customer) + 5-cohort → account-age R + null quintiles', async () => {
    const { service } = makeService();
    // Lurker signed up 200 days ago → dormant per §S-5.
    const accountCreated = new Date(NOW.getTime() - 200 * 86_400_000);
    mockCustomerFound(tx, {
      state: 'active',
      shopifyCreatedAt: accountCreated,
      createdAt: accountCreated,
    });
    mockMerchantFound(tx);
    // Cohort is 5 OTHER customers — our target NOT included.
    tx.$queryRaw.mockResolvedValue([
      { customerId: 'other_1', rDays: 5, fCount: 10, mCents: 100_000n },
      { customerId: 'other_2', rDays: 20, fCount: 7, mCents: 50_000n },
      { customerId: 'other_3', rDays: 60, fCount: 4, mCents: 20_000n },
      { customerId: 'other_4', rDays: 200, fCount: 2, mCents: 5_000n },
      { customerId: 'other_5', rDays: 400, fCount: 1, mCents: 1_000n },
    ]);

    const result = await withTenantScope(MERCHANT_ID, async () =>
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    );

    if (result.skipped !== null) throw new Error('expected applied result');
    expect(result.branchTaken).toBe('lurker');
    expect(result.rDays).toBe(200);
    expect(result.fCount).toBe(0);
    expect(result.mCents).toBe(0n);
    expect(result.rQuintile).toBeNull();
    expect(result.fQuintile).toBeNull();
    expect(result.mQuintile).toBeNull();
    expect(result.churnRiskScore).toBeNull();
    expect(result.newState).toBe('dormant');
    expect(result.stateChanged).toBe(true);
  });

  it('lurker + insufficient cohort (4 others) → state=insufficient_data', async () => {
    const { service } = makeService();
    mockCustomerFound(tx, { state: 'active' });
    mockMerchantFound(tx);
    tx.$queryRaw.mockResolvedValue([
      { customerId: 'other_1', rDays: 5, fCount: 10, mCents: 100_000n },
      { customerId: 'other_2', rDays: 20, fCount: 7, mCents: 50_000n },
      { customerId: 'other_3', rDays: 60, fCount: 4, mCents: 20_000n },
      { customerId: 'other_4', rDays: 200, fCount: 2, mCents: 5_000n },
    ]); // 4 others → below threshold

    const result = await withTenantScope(MERCHANT_ID, async () =>
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    );

    if (result.skipped !== null) throw new Error('expected applied result');
    expect(result.branchTaken).toBe('lurker');
    expect(result.newState).toBe('insufficient_data');
    expect(result.fCount).toBe(0);
    expect(result.mCents).toBe(0n);
  });

  it('lurker with NULL shopifyCreatedAt falls back to local createdAt', async () => {
    const { service } = makeService();
    const localCreated = new Date(NOW.getTime() - 50 * 86_400_000); // 50d ago → warm
    mockCustomerFound(tx, {
      state: 'active',
      shopifyCreatedAt: null,
      createdAt: localCreated,
    });
    mockMerchantFound(tx);
    tx.$queryRaw.mockResolvedValue([
      { customerId: 'other_1', rDays: 5, fCount: 10, mCents: 100_000n },
      { customerId: 'other_2', rDays: 20, fCount: 7, mCents: 50_000n },
      { customerId: 'other_3', rDays: 60, fCount: 4, mCents: 20_000n },
      { customerId: 'other_4', rDays: 200, fCount: 2, mCents: 5_000n },
      { customerId: 'other_5', rDays: 400, fCount: 1, mCents: 1_000n },
    ]);

    const result = await withTenantScope(MERCHANT_ID, async () =>
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    );

    if (result.skipped !== null) throw new Error('expected applied result');
    expect(result.branchTaken).toBe('lurker');
    expect(result.rDays).toBe(50);
    expect(result.newState).toBe('warm');
  });

  it('lurker branch records the lurker tag in the audit log context', async () => {
    const { service } = makeService();
    const accountCreated = new Date(NOW.getTime() - 200 * 86_400_000);
    mockCustomerFound(tx, {
      state: 'active',
      shopifyCreatedAt: accountCreated,
      createdAt: accountCreated,
    });
    mockMerchantFound(tx);
    tx.$queryRaw.mockResolvedValue([
      { customerId: 'other_1', rDays: 5, fCount: 10, mCents: 100_000n },
      { customerId: 'other_2', rDays: 20, fCount: 7, mCents: 50_000n },
      { customerId: 'other_3', rDays: 60, fCount: 4, mCents: 20_000n },
      { customerId: 'other_4', rDays: 200, fCount: 2, mCents: 5_000n },
      { customerId: 'other_5', rDays: 400, fCount: 1, mCents: 1_000n },
    ]);

    await withTenantScope(MERCHANT_ID, async () =>
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    );

    const auditCall = tx.auditLog.create.mock.calls[0]![0];
    expect(auditCall.data.context).toMatchObject({
      oldState: 'active',
      newState: 'dormant',
      branch: 'lurker',
      rDays: 200,
      fCount: 0,
      mCents: '0', // BigInt → string per rule #19
    });
  });

  it('lurker + brand-new account (0 days) + full cohort → active, branch=lurker, no state change vs default', async () => {
    const { service } = makeService();
    mockCustomerFound(tx, {
      state: 'active',
      shopifyCreatedAt: NOW,
      createdAt: NOW,
    });
    mockMerchantFound(tx);
    tx.$queryRaw.mockResolvedValue([
      { customerId: 'other_1', rDays: 5, fCount: 10, mCents: 100_000n },
      { customerId: 'other_2', rDays: 20, fCount: 7, mCents: 50_000n },
      { customerId: 'other_3', rDays: 60, fCount: 4, mCents: 20_000n },
      { customerId: 'other_4', rDays: 200, fCount: 2, mCents: 5_000n },
      { customerId: 'other_5', rDays: 400, fCount: 1, mCents: 1_000n },
    ]);

    const result = await withTenantScope(MERCHANT_ID, async () =>
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    );

    if (result.skipped !== null) throw new Error('expected applied result');
    expect(result.branchTaken).toBe('lurker');
    expect(result.rDays).toBe(0);
    expect(result.newState).toBe('active');
    expect(result.stateChanged).toBe(false); // active → active
  });
});

// ===========================================================================
// Side-effect details
// ===========================================================================

describe('CustomerScoreService.recompute — side-effect details on state change', () => {
  let tx: MockTx;
  beforeEach(() => {
    tx = makeTx();
  });

  it('mCents serialized as decimal string in both audit context and outbox payload', async () => {
    const { service } = makeService();
    mockCustomerFound(tx, { state: 'active' });
    mockMerchantFound(tx);
    tx.$queryRaw.mockResolvedValue(fullCohort({ rDays: 60, fCount: 4, mCents: 20_000n }));

    await withTenantScope(MERCHANT_ID, async () =>
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    );

    expect(tx.auditLog.create.mock.calls[0]![0].data.context).toMatchObject({
      mCents: '20000',
    });
    expect(tx.outboxEvent.create.mock.calls[0]![0].data.payload).toMatchObject({
      rfmScore: expect.objectContaining({ mCents: '20000' }),
    });
  });

  it('outbox event type is OUTBOX_EVENTS.customer.state_changed', async () => {
    const { service } = makeService();
    mockCustomerFound(tx, { state: 'active' });
    mockMerchantFound(tx);
    tx.$queryRaw.mockResolvedValue(fullCohort({ rDays: 60, fCount: 4, mCents: 20_000n }));

    await withTenantScope(MERCHANT_ID, async () =>
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    );

    expect(tx.outboxEvent.create.mock.calls[0]![0].data.type).toBe('customer.state_changed');
  });

  it('audit-log action is AUDIT_ACTIONS.customer.state_changed; actorType=system; actorId=drainer', async () => {
    const { service } = makeService();
    mockCustomerFound(tx, { state: 'active' });
    mockMerchantFound(tx);
    tx.$queryRaw.mockResolvedValue(fullCohort({ rDays: 60, fCount: 4, mCents: 20_000n }));

    await withTenantScope(MERCHANT_ID, async () =>
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    );

    const auditCall = tx.auditLog.create.mock.calls[0]![0];
    expect(auditCall.data.action).toBe('customer.state_changed');
    expect(auditCall.data.actorType).toBe('system');
    expect(auditCall.data.actorId).toBe('drainer');
    expect(auditCall.data.shop).toBe(SHOP);
    expect(auditCall.data.targetType).toBe('customer');
    expect(auditCall.data.targetId).toBe(CUSTOMER_ID);
  });

  it('Merchant.currency null → snapshots "USD" as the row currency + emits Q-H1 WARN log with operator context', async () => {
    warnSpy.mockClear();

    // 5 minutes after install — un-enriched window.
    const installedAt = new Date('2026-05-20T11:55:00.000Z');
    const shopDetailsFetchedAt = null;

    const { service } = makeService();
    mockCustomerFound(tx, { state: 'active' });
    mockMerchantFound(tx, null, installedAt, shopDetailsFetchedAt);
    tx.$queryRaw.mockResolvedValue(fullCohort({ rDays: 60, fCount: 4, mCents: 20_000n }));

    await withTenantScope(MERCHANT_ID, async () =>
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    );

    // Fallback applied to the snapshot column.
    expect(tx.customerScore.upsert.mock.calls[0]![0].create.currency).toBe('USD');

    // Q-H1: WARN log fires with full operator context (Q-S3 shape).
    const warnCall = warnSpy.mock.calls.find((call) =>
      String(call[1] ?? '').includes(
        'merchant currency not enriched; falling back to USD',
      ),
    );
    expect(warnCall).toBeDefined();
    const [warnCtx, warnMessage] = warnCall as [Record<string, unknown>, string];

    expect(warnCtx.merchantId).toBe(MERCHANT_ID);
    expect(warnCtx.shop).toBe(SHOP);
    expect(warnCtx.installedAt).toBe(installedAt.toISOString());
    expect(warnCtx.shopDetailsFetchedAt).toBeNull();
    expect(warnCtx.eventTrigger).toBe('scoring');
    // Q-S3: timeSinceInstallMs lets operators distinguish "normal
    // install window" (<10min, D3 hasn't tried yet) from "D3 sweep
    // failing repeatedly" (>10min, sweep should have healed).
    expect(typeof warnCtx.timeSinceInstallMs).toBe('number');
    expect(warnCtx.timeSinceInstallMs).toBeGreaterThanOrEqual(0);
    expect(warnMessage).toContain('D3 enrichment-sweep will heal');
  });

  it('Merchant.currency populated → no Q-H1 WARN log on happy path', async () => {
    warnSpy.mockClear();

    const { service } = makeService();
    mockCustomerFound(tx, { state: 'active' });
    mockMerchantFound(tx, 'EUR');
    tx.$queryRaw.mockResolvedValue(fullCohort({ rDays: 60, fCount: 4, mCents: 20_000n }));

    await withTenantScope(MERCHANT_ID, async () =>
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    );

    expect(tx.customerScore.upsert.mock.calls[0]![0].create.currency).toBe('EUR');

    const unEnrichedWarn = warnSpy.mock.calls.find((call) =>
      String(call[1] ?? '').includes('merchant currency not enriched'),
    );
    expect(unEnrichedWarn).toBeUndefined();
  });

  it('reports cohortSize + durationMs (S-10 observability)', async () => {
    const { service } = makeService();
    mockCustomerFound(tx, { state: 'active' });
    mockMerchantFound(tx);
    tx.$queryRaw.mockResolvedValue(fullCohort());

    const result = await withTenantScope(MERCHANT_ID, async () =>
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    );

    if (result.skipped !== null) throw new Error('expected applied result');
    expect(result.cohortSize).toBe(5);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ===========================================================================
// First-pass suppression gate — A1a (Lock V10 / POST-EPIC-F §1 / lock #22 C9)
//
// While Merchant.scoringInitializedAt is null, a band change is an initial
// assignment, NOT a real transition: the Customer.state write + CustomerScore
// upsert still happen (data correct), but the AuditLog + OutboxEvent
// (transition reactions) are suppressed. Once the flag is set, both emit.
// ===========================================================================

describe('CustomerScoreService.recompute — first-pass suppression gate (A1a)', () => {
  let tx: MockTx;
  beforeEach(() => {
    tx = makeTx();
  });

  it('scoringInitializedAt null + state change → state written + score upserted, but NO audit + NO outbox', async () => {
    const { service } = makeService();
    mockCustomerFound(tx, { state: 'active' });
    // Un-initialized merchant — pass null for the 5th positional arg.
    mockMerchantFound(tx, 'USD', undefined, undefined, null);
    tx.$queryRaw.mockResolvedValue(fullCohort({ rDays: 60, fCount: 4, mCents: 20_000n }));

    const result = await withTenantScope(MERCHANT_ID, async () =>
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    );

    if (result.skipped !== null) throw new Error('expected applied result');
    // Data writes ARE performed — the band must be correct regardless.
    expect(result.stateChanged).toBe(true);
    expect(result.newState).toBe('warm');
    expect(tx.customer.update).toHaveBeenCalledWith({
      where: { id: CUSTOMER_ID },
      data: { state: 'warm' },
    });
    expect(tx.customerScore.upsert).toHaveBeenCalledTimes(1);
    // Transition-reaction side-effects SUPPRESSED.
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('scoringInitializedAt set + state change → audit + outbox both emitted (steady-state regression guard)', async () => {
    const { service } = makeService();
    mockCustomerFound(tx, { state: 'active' });
    mockMerchantFound(tx, 'USD', undefined, undefined, new Date('2026-05-19T12:05:00.000Z'));
    tx.$queryRaw.mockResolvedValue(fullCohort({ rDays: 60, fCount: 4, mCents: 20_000n }));

    await withTenantScope(MERCHANT_ID, async () =>
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    );

    expect(tx.customer.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
  });

  it('scoringInitializedAt null + NO state change → score upserted, nothing else (gate is moot without a transition)', async () => {
    const { service } = makeService();
    // Top-of-cohort customer (rDays=5) already 'active' → stays active.
    mockCustomerFound(tx, { state: 'active' });
    mockMerchantFound(tx, 'USD', undefined, undefined, null);
    tx.$queryRaw.mockResolvedValue(fullCohort());

    const result = await withTenantScope(MERCHANT_ID, async () =>
      service.recompute({
        merchantId: MERCHANT_ID,
        customerId: CUSTOMER_ID,
        tx: tx as unknown as Prisma.TransactionClient,
        now: NOW,
      }),
    );

    if (result.skipped !== null) throw new Error('expected applied result');
    expect(result.stateChanged).toBe(false);
    expect(tx.customer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    // Score still upserted (computedAt refresh) even with the gate closed.
    expect(tx.customerScore.upsert).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// bulkRescore — A1b first-pass engine (mocked prisma)
//
// A1b's bulkRescore reads the cohort ONCE, computes boundaries ONCE, scores
// every customer in batches, and NEVER emits (Design B). The flag-flip + the
// single merchant.scoring_initialized audit land in a final tx. These mocked
// tests lock the invariants; the real-DB no-storm proof is in the drainer
// integration suite.
// ===========================================================================

/**
 * Mock prisma for bulkRescore: `$transaction` runs the UnitOfWork callback
 * with the shared mock tx; `merchant.findUnique` serves the initial
 * currency/shop read (NOT inside a tx).
 */
function makeBulkPrisma(
  tx: MockTx,
  merchantRow: { currency: string | null; shop: string } | null,
): WinbackPrisma {
  return {
    $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    merchant: { findUnique: vi.fn().mockResolvedValue(merchantRow) },
  } as unknown as WinbackPrisma;
}

describe('CustomerScoreService.bulkRescore — A1b first-pass (mocked prisma)', () => {
  let tx: MockTx;
  beforeEach(() => {
    tx = makeTx();
  });

  it('scores scorable + lurker, NEVER emits, single merchant.scoring_initialized audit, flag set; cohort read ONCE', async () => {
    const { service } = makeService();
    const prisma = makeBulkPrisma(tx, { currency: 'USD', shop: SHOP });

    // Sufficient cohort (5) so quintiles compute. 'cust_scorable' is a member.
    tx.$queryRaw.mockResolvedValue([
      { customerId: 'cust_scorable', rDays: 60, fCount: 4, mCents: 20_000n },
      { customerId: 'co2', rDays: 5, fCount: 10, mCents: 100_000n },
      { customerId: 'co3', rDays: 20, fCount: 7, mCents: 50_000n },
      { customerId: 'co4', rDays: 200, fCount: 2, mCents: 5_000n },
      { customerId: 'co5', rDays: 400, fCount: 1, mCents: 1_000n },
    ]);

    // One batch: a scorable (in cohort, → warm) + a lurker (absent, 200d → dormant).
    const lurkerCreated = new Date(NOW.getTime() - 200 * 86_400_000);
    tx.customer.findMany
      .mockResolvedValueOnce([
        { id: 'cust_scorable', state: 'active', shopifyCreatedAt: null, createdAt: NOW },
        {
          id: 'cust_lurker',
          state: 'active',
          shopifyCreatedAt: lurkerCreated,
          createdAt: lurkerCreated,
        },
      ])
      .mockResolvedValue([]);

    const result = await withTenantScope(MERCHANT_ID, async () =>
      service.bulkRescore(prisma, { merchantId: MERCHANT_ID, actorId: 'op-1', now: NOW }),
    );

    expect(result.customersScored).toBe(2);
    expect(result.batches).toBe(1);
    expect(result.cohortSize).toBe(5);

    // Both customers scored; both transitioned from 'active' → one state write each.
    expect(tx.customerScore.upsert).toHaveBeenCalledTimes(2);
    expect(tx.customer.update).toHaveBeenCalledTimes(2);

    // NEVER emits.
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();

    // Exactly ONE audit — merchant.scoring_initialized (NOT customer.state_changed).
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const auditCall = tx.auditLog.create.mock.calls[0]![0];
    expect(auditCall.data.action).toBe('merchant.scoring_initialized');
    expect(auditCall.data.targetType).toBe('merchant');
    expect(auditCall.data.targetId).toBe(MERCHANT_ID);
    expect(auditCall.data.actorId).toBe('op-1');

    // Flag set in the final tx — exactly once.
    expect(tx.merchant.update).toHaveBeenCalledTimes(1);
    expect(tx.merchant.update.mock.calls[0]![0]).toEqual({
      where: { id: MERCHANT_ID },
      data: { scoringInitializedAt: NOW },
    });

    // Cohort read EXACTLY ONCE — the O(1)-cohort-read guarantee (D4).
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('insufficient cohort (<5) → every customer insufficient_data, still no emission, flag set', async () => {
    const { service } = makeService();
    const prisma = makeBulkPrisma(tx, { currency: 'USD', shop: SHOP });

    tx.$queryRaw.mockResolvedValue([
      { customerId: 'cust_scorable', rDays: 60, fCount: 4, mCents: 20_000n },
      { customerId: 'co2', rDays: 5, fCount: 10, mCents: 100_000n },
      { customerId: 'co3', rDays: 20, fCount: 7, mCents: 50_000n },
    ]); // 3 < threshold (5)

    tx.customer.findMany
      .mockResolvedValueOnce([
        { id: 'cust_scorable', state: 'active', shopifyCreatedAt: null, createdAt: NOW },
      ])
      .mockResolvedValue([]);

    await withTenantScope(MERCHANT_ID, async () =>
      service.bulkRescore(prisma, { merchantId: MERCHANT_ID, actorId: 'op-1', now: NOW }),
    );

    // Even the in-cohort customer goes insufficient_data (cohort too small).
    expect(tx.customer.update).toHaveBeenCalledWith({
      where: { id: 'cust_scorable' },
      data: { state: 'insufficient_data' },
    });
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(tx.merchant.update).toHaveBeenCalledTimes(1);
  });

  it('customer already at the resolved state → no redundant customer.update (still scored, still no emit)', async () => {
    const { service } = makeService();
    const prisma = makeBulkPrisma(tx, { currency: 'USD', shop: SHOP });

    tx.$queryRaw.mockResolvedValue([
      { customerId: 'c_top', rDays: 5, fCount: 10, mCents: 100_000n },
      { customerId: 'co2', rDays: 20, fCount: 7, mCents: 50_000n },
      { customerId: 'co3', rDays: 60, fCount: 4, mCents: 20_000n },
      { customerId: 'co4', rDays: 200, fCount: 2, mCents: 5_000n },
      { customerId: 'co5', rDays: 400, fCount: 1, mCents: 1_000n },
    ]);

    // c_top (rDays=5) resolves to 'active' and is ALREADY 'active' → no state write.
    tx.customer.findMany
      .mockResolvedValueOnce([
        { id: 'c_top', state: 'active', shopifyCreatedAt: null, createdAt: NOW },
      ])
      .mockResolvedValue([]);

    await withTenantScope(MERCHANT_ID, async () =>
      service.bulkRescore(prisma, { merchantId: MERCHANT_ID, actorId: 'op-1', now: NOW }),
    );

    expect(tx.customerScore.upsert).toHaveBeenCalledTimes(1); // scored
    expect(tx.customer.update).not.toHaveBeenCalled(); // no band change
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// decayRescore — daily decay sweep (mocked prisma)
//
// The steady-state calendar-driven transition detector. Reads the cohort
// ONCE, re-evaluates the working set, and EMITS customer.state_changed for
// real band transitions — GATED on scoringInitializedAt (same §1 gate as
// recompute). Mirrors bulkRescore's mock harness; the real-DB emit proof is
// in the drainer integration suite.
// ===========================================================================

/**
 * Mock prisma for decayRescore: `$transaction` runs the UnitOfWork callback
 * with the shared mock tx; `merchant.findUnique` serves the currency / shop /
 * scoringInitializedAt read (NOT inside a tx).
 */
function makeDecayPrisma(
  tx: MockTx,
  merchantRow:
    | { currency: string | null; shop: string; scoringInitializedAt: Date | null }
    | null,
): WinbackPrisma {
  return {
    $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    merchant: { findUnique: vi.fn().mockResolvedValue(merchantRow) },
  } as unknown as WinbackPrisma;
}

/** A sufficient (≥5) cohort so scorable customers resolve via quintiles. */
function sufficientCohort(): unknown[] {
  return [
    { customerId: 'cd1', rDays: 5, fCount: 10, mCents: 100_000n },
    { customerId: 'cd2', rDays: 20, fCount: 7, mCents: 50_000n },
    { customerId: 'cd3', rDays: 60, fCount: 4, mCents: 20_000n },
    { customerId: 'cd4', rDays: 200, fCount: 2, mCents: 5_000n },
    { customerId: 'cd5', rDays: 400, fCount: 1, mCents: 1_000n },
  ];
}

describe('CustomerScoreService.decayRescore — daily sweep (mocked prisma)', () => {
  let tx: MockTx;
  beforeEach(() => {
    tx = makeTx();
  });

  it('working-set filter: customer.findMany scopes to active/warm/at_risk/dormant (skips lost + insufficient_data)', async () => {
    const { service } = makeService();
    const prisma = makeDecayPrisma(tx, {
      currency: 'USD',
      shop: SHOP,
      scoringInitializedAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    tx.$queryRaw.mockResolvedValue(sufficientCohort());
    tx.customer.findMany.mockResolvedValue([]); // empty working set → one batch

    await withTenantScope(MERCHANT_ID, async () =>
      service.decayRescore(prisma, { merchantId: MERCHANT_ID, actorId: 'scheduler', now: NOW }),
    );

    const findManyArgs = tx.customer.findMany.mock.calls[0]![0] as {
      where: { state: { in: string[] } };
    };
    expect(findManyArgs.where.state.in).toEqual(['active', 'warm', 'at_risk', 'dormant']);
  });

  it('initialized merchant + band CROSSED → state update + customer.state_changed audit + OutboxEvent (emit)', async () => {
    const { service } = makeService();
    const prisma = makeDecayPrisma(tx, {
      currency: 'USD',
      shop: SHOP,
      scoringInitializedAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    tx.$queryRaw.mockResolvedValue(sufficientCohort());

    // A lurker (absent from cohort) created 200 days before NOW → rDays 200 →
    // dormant. Currently 'warm' → CROSSES warm→dormant.
    const created200 = new Date(NOW.getTime() - 200 * 86_400_000);
    tx.customer.findMany
      .mockResolvedValueOnce([
        {
          id: 'cust_decay',
          state: 'warm',
          shopifyCustomerId: SHOP_CUSTOMER_GID,
          shopifyCreatedAt: created200,
          createdAt: created200,
        },
      ])
      .mockResolvedValue([]);

    const result = await withTenantScope(MERCHANT_ID, async () =>
      service.decayRescore(prisma, { merchantId: MERCHANT_ID, actorId: 'scheduler', now: NOW }),
    );

    expect(result.transitions).toBe(1);
    expect(result.emitted).toBe(1);

    // Scored + band updated.
    expect(tx.customerScore.upsert).toHaveBeenCalledTimes(1);
    expect(tx.customer.update).toHaveBeenCalledWith({
      where: { id: 'cust_decay' },
      data: { state: 'dormant' },
    });

    // Emitted: exactly one customer.state_changed audit with the decay
    // discriminator, and one OutboxEvent.
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = tx.auditLog.create.mock.calls[0]![0] as {
      data: { action: string; targetType: string; targetId: string; actorId: string; context: Record<string, unknown> };
    };
    expect(audit.data.action).toBe('customer.state_changed');
    expect(audit.data.targetType).toBe('customer');
    expect(audit.data.targetId).toBe('cust_decay');
    expect(audit.data.actorId).toBe('scheduler');
    expect(audit.data.context.oldState).toBe('warm');
    expect(audit.data.context.newState).toBe('dormant');
    expect(audit.data.context.trigger).toBe('decay_sweep');

    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
    const oe = tx.outboxEvent.create.mock.calls[0]![0] as {
      data: { type: string; payload: { oldState: string; newState: string } };
    };
    expect(oe.data.type).toBe('customer.state_changed');
    expect(oe.data.payload.oldState).toBe('warm');
    expect(oe.data.payload.newState).toBe('dormant');

    // Cohort read EXACTLY ONCE.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('band NOT crossed → scored (upsert) but NO state update, NO emit', async () => {
    const { service } = makeService();
    const prisma = makeDecayPrisma(tx, {
      currency: 'USD',
      shop: SHOP,
      scoringInitializedAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    tx.$queryRaw.mockResolvedValue(sufficientCohort());

    // Lurker created 200d before NOW → dormant. Already 'dormant' → no cross.
    const created200 = new Date(NOW.getTime() - 200 * 86_400_000);
    tx.customer.findMany
      .mockResolvedValueOnce([
        {
          id: 'cust_stable',
          state: 'dormant',
          shopifyCustomerId: SHOP_CUSTOMER_GID,
          shopifyCreatedAt: created200,
          createdAt: created200,
        },
      ])
      .mockResolvedValue([]);

    const result = await withTenantScope(MERCHANT_ID, async () =>
      service.decayRescore(prisma, { merchantId: MERCHANT_ID, actorId: 'scheduler', now: NOW }),
    );

    expect(result.transitions).toBe(0);
    expect(result.emitted).toBe(0);
    expect(tx.customerScore.upsert).toHaveBeenCalledTimes(1); // still scored
    expect(tx.customer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('NOT-yet-initialized merchant (scoringInitializedAt null) + band crossed → state update but NO emit (§1 gate)', async () => {
    const { service } = makeService();
    const prisma = makeDecayPrisma(tx, {
      currency: 'USD',
      shop: SHOP,
      scoringInitializedAt: null, // gate CLOSED
    });
    tx.$queryRaw.mockResolvedValue(sufficientCohort());

    const created200 = new Date(NOW.getTime() - 200 * 86_400_000);
    tx.customer.findMany
      .mockResolvedValueOnce([
        {
          id: 'cust_gated',
          state: 'warm',
          shopifyCustomerId: SHOP_CUSTOMER_GID,
          shopifyCreatedAt: created200,
          createdAt: created200,
        },
      ])
      .mockResolvedValue([]);

    const result = await withTenantScope(MERCHANT_ID, async () =>
      service.decayRescore(prisma, { merchantId: MERCHANT_ID, actorId: 'scheduler', now: NOW }),
    );

    // Band data write happens (unconditional, lock #22 / C9)...
    expect(result.transitions).toBe(1);
    expect(tx.customer.update).toHaveBeenCalledWith({
      where: { id: 'cust_gated' },
      data: { state: 'dormant' },
    });
    // ...but emission is suppressed (gate closed).
    expect(result.emitted).toBe(0);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('boundary: lurker exactly 90 days old → warm (≤ wins), with PINNED clock for determinism', async () => {
    // Pin the clock so the floor-of-day arithmetic in lurkerRDays is exact:
    // a real-clock `now` would make (now - createdAt) drift a few ms over
    // exactly-90-days and could floor to 90 or, on a slow boundary, jitter.
    const pinnedNow = new Date('2026-06-10T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(pinnedNow);
    try {
      const { service } = makeService();
      const prisma = makeDecayPrisma(tx, {
        currency: 'USD',
        shop: SHOP,
        scoringInitializedAt: new Date('2026-05-01T00:00:00.000Z'),
      });
      tx.$queryRaw.mockResolvedValue(sufficientCohort());

      // Exactly 90 days before pinnedNow → rDays = 90 → stateFromRecency(90)
      // = warm (warm_max = 90, ≤ wins). Currently 'active' → crosses to warm.
      const created90 = new Date(pinnedNow.getTime() - 90 * 86_400_000);
      tx.customer.findMany
        .mockResolvedValueOnce([
          {
            id: 'cust_boundary',
            state: 'active',
            shopifyCustomerId: SHOP_CUSTOMER_GID,
            shopifyCreatedAt: created90,
            createdAt: created90,
          },
        ])
        .mockResolvedValue([]);

      // No explicit `now` → method defaults to Date.now() (pinned).
      await withTenantScope(MERCHANT_ID, async () =>
        service.decayRescore(prisma, { merchantId: MERCHANT_ID, actorId: 'scheduler' }),
      );

      expect(tx.customer.update).toHaveBeenCalledWith({
        where: { id: 'cust_boundary' },
        data: { state: 'warm' }, // 90 → warm, NOT at_risk (91 would be at_risk)
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
