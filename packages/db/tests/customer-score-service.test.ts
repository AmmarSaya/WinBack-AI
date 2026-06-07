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
  customer: { findUnique: Mock; update: Mock };
  merchant: { findUnique: Mock };
  outboxEvent: { create: Mock };
  customerScore: { findUnique: Mock; upsert: Mock };
  auditLog: { create: Mock };
}

function makeTx(): MockTx {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    customer: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({ id: CUSTOMER_ID }) },
    merchant: { findUnique: vi.fn() },
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
): void {
  tx.merchant.findUnique.mockResolvedValue({
    currency,
    shop: SHOP,
    installedAt,
    shopDetailsFetchedAt,
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
