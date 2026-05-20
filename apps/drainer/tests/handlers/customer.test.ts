/**
 * Unit tests for the post-Epic-E-session-2 customer handlers.
 *
 * Same mocking strategy as order.test.ts: vi.mock + vi.hoisted to replace
 * `CustomerRepository` + `CustomerScoreService` + pass-through
 * `withTenantScope`.  Session 2 wires scoring INTO the create/update path
 * (in the same tx as the customer upsert).  Delete handler does NOT call
 * scoring per §S-7 (soft delete excludes from future cohort reads;
 * existing CustomerScore row stays as forensic).  Real-DB coverage in
 * batch 5's drainer integration harness extension.
 */

import type { OutboxEventRow } from '@winback/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DrainerContext } from '../../src/context.js';

const mocks = vi.hoisted(() => ({
  upsertFromWebhook: vi.fn(),
  softDelete: vi.fn(),
  recompute: vi.fn(),
}));

vi.mock('@winback/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@winback/db')>();
  return {
    ...actual,
    CustomerRepository: vi.fn().mockImplementation(() => ({
      upsertFromWebhook: mocks.upsertFromWebhook,
      softDelete: mocks.softDelete,
    })),
    CustomerScoreRepository: vi.fn().mockImplementation(() => ({})),
    AuditLogRepository: vi.fn().mockImplementation(() => ({})),
    CustomerScoreService: vi.fn().mockImplementation(() => ({
      recompute: mocks.recompute,
    })),
    withTenantScope: <T,>(_id: string, fn: () => Promise<T>) => fn(),
  };
});

const { handleCustomerCreated, handleCustomerDeleted, handleCustomerUpdated } = await import(
  '../../src/handlers/customer.js'
);

function makeRow(type: string, payload: unknown): OutboxEventRow {
  return {
    id: 'row-' + type,
    merchantId: 'merchant-1',
    type,
    payload,
    createdAt: new Date(),
    attempts: 0,
    deadLetteredAt: null,
    deferredFailedAt: null,
  };
}

function makeCtx(): DrainerContext {
  const stubTx = { __stub: true } as unknown;
  const stubPrisma = {
    $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(stubTx)),
  } as unknown as DrainerContext['prisma'];
  return {
    prisma: stubPrisma,
    queues: {} as DrainerContext['queues'],
    shopifyConfig: {} as DrainerContext['shopifyConfig'],
  };
}

/** Producer-shaped customer payload satisfying the post-batch-2 schema. */
function customerPayload(args: {
  topic: 'customers/create' | 'customers/update' | 'customers/delete';
  webhookId: string;
  shopifyCustomerId: number | string;
  bodyOverrides?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    topic: args.topic,
    webhookId: args.webhookId,
    body: {
      id: args.shopifyCustomerId,
      created_at: '2026-05-19T12:00:00Z',
      updated_at: '2026-05-19T12:00:00Z',
      ...(args.bodyOverrides ?? {}),
    },
  };
}

/** Default scoring result — applied, scorable branch, no state change. */
function defaultScoringResult() {
  return {
    skipped: null,
    customerScoreId: 'score_1',
    isNewScore: true,
    rDays: 5,
    fCount: 1,
    mCents: 19_995n,
    rQuintile: 5,
    fQuintile: 5,
    mQuintile: 5,
    churnRiskScore: 0,
    previousState: 'active' as const,
    newState: 'active' as const,
    stateChanged: false,
    branchTaken: 'scorable' as const,
    cohortSize: 8,
    durationMs: 9,
  };
}

beforeEach(() => {
  mocks.upsertFromWebhook.mockResolvedValue({
    customerId: 'cust_local_1',
    isNewCustomer: true,
  });
  mocks.softDelete.mockResolvedValue({ existed: true });
  mocks.recompute.mockResolvedValue(defaultScoringResult());
});

afterEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// handleCustomerCreated + handleCustomerUpdated
// ===========================================================================

describe('handleCustomerCreated', () => {
  it('calls CustomerRepository.upsertFromWebhook with merchantId + body + tx', async () => {
    const ctx = makeCtx();
    await handleCustomerCreated(
      ctx,
      makeRow(
        'customer.created',
        customerPayload({ topic: 'customers/create', webhookId: 'wh-c1', shopifyCustomerId: 42 }),
      ),
    );

    expect(mocks.upsertFromWebhook).toHaveBeenCalledTimes(1);
    const call = mocks.upsertFromWebhook.mock.calls[0]![0];
    expect(call.merchantId).toBe('merchant-1');
    expect(call.body.id).toBe(42);
    expect(call.tx).toBeDefined();
  });

  it('calls CustomerScoreService.recompute inline with the upserted customerId + same tx', async () => {
    const ctx = makeCtx();
    await handleCustomerCreated(
      ctx,
      makeRow(
        'customer.created',
        customerPayload({ topic: 'customers/create', webhookId: 'wh-c2', shopifyCustomerId: 99 }),
      ),
    );

    expect(mocks.recompute).toHaveBeenCalledTimes(1);
    const call = mocks.recompute.mock.calls[0]![0];
    expect(call.merchantId).toBe('merchant-1');
    expect(call.customerId).toBe('cust_local_1');
    expect(call.tx).toBe(mocks.upsertFromWebhook.mock.calls[0]![0].tx);
  });

  it('repository throw propagates and skips scoring entirely', async () => {
    mocks.upsertFromWebhook.mockRejectedValueOnce(new Error('test: upsert failed'));
    const ctx = makeCtx();
    await expect(
      handleCustomerCreated(
        ctx,
        makeRow(
          'customer.created',
          customerPayload({ topic: 'customers/create', webhookId: 'wh-fail', shopifyCustomerId: 1 }),
        ),
      ),
    ).rejects.toThrow(/upsert failed/);
    expect(mocks.recompute).not.toHaveBeenCalled();
  });

  it('scoring throw propagates (parent tx rolls back the customer upsert via the prisma transaction)', async () => {
    mocks.recompute.mockRejectedValueOnce(new Error('test: scoring failure'));
    const ctx = makeCtx();
    await expect(
      handleCustomerCreated(
        ctx,
        makeRow(
          'customer.created',
          customerPayload({ topic: 'customers/create', webhookId: 'wh-sfail', shopifyCustomerId: 2 }),
        ),
      ),
    ).rejects.toThrow(/scoring failure/);
  });
});

describe('handleCustomerUpdated', () => {
  it('calls CustomerRepository.upsertFromWebhook (same logic as create — idempotent upsert)', async () => {
    const ctx = makeCtx();
    await handleCustomerUpdated(
      ctx,
      makeRow(
        'customer.updated',
        customerPayload({ topic: 'customers/update', webhookId: 'wh-u1', shopifyCustomerId: 77 }),
      ),
    );

    expect(mocks.upsertFromWebhook).toHaveBeenCalledTimes(1);
    expect(mocks.upsertFromWebhook.mock.calls[0]![0].body.id).toBe(77);
  });

  it('always invokes scoring on customer.updated (v1 simplification per §S-7)', async () => {
    const ctx = makeCtx();
    await handleCustomerUpdated(
      ctx,
      makeRow(
        'customer.updated',
        customerPayload({ topic: 'customers/update', webhookId: 'wh-u2', shopifyCustomerId: 78 }),
      ),
    );

    expect(mocks.recompute).toHaveBeenCalledTimes(1);
    expect(mocks.recompute.mock.calls[0]![0].customerId).toBe('cust_local_1');
  });
});

// ===========================================================================
// handleCustomerDeleted — NO scoring per §S-7
// ===========================================================================

describe('handleCustomerDeleted', () => {
  it('wraps body.id into a Customer GID and calls softDelete', async () => {
    const ctx = makeCtx();
    await handleCustomerDeleted(
      ctx,
      makeRow(
        'customer.deleted',
        customerPayload({ topic: 'customers/delete', webhookId: 'wh-d1', shopifyCustomerId: 555 }),
      ),
    );

    expect(mocks.softDelete).toHaveBeenCalledTimes(1);
    const call = mocks.softDelete.mock.calls[0]![0];
    expect(call.merchantId).toBe('merchant-1');
    expect(call.shopifyCustomerId).toBe('gid://shopify/Customer/555');
    expect(call.tx).toBeDefined();
  });

  it('NEVER calls CustomerScoreService.recompute (§S-7 lock — soft delete excludes from future cohorts)', async () => {
    const ctx = makeCtx();
    await handleCustomerDeleted(
      ctx,
      makeRow(
        'customer.deleted',
        customerPayload({ topic: 'customers/delete', webhookId: 'wh-d-noscore', shopifyCustomerId: 123 }),
      ),
    );

    expect(mocks.softDelete).toHaveBeenCalledTimes(1);
    expect(mocks.recompute).not.toHaveBeenCalled();
  });

  it('existed=false (already-deleted or absent) → returns without throwing (idempotent), still no scoring', async () => {
    mocks.softDelete.mockResolvedValue({ existed: false });
    const ctx = makeCtx();
    await expect(
      handleCustomerDeleted(
        ctx,
        makeRow(
          'customer.deleted',
          customerPayload({ topic: 'customers/delete', webhookId: 'wh-d2', shopifyCustomerId: 1 }),
        ),
      ),
    ).resolves.toBeUndefined();
    expect(mocks.recompute).not.toHaveBeenCalled();
  });

  it('non-numeric body.id → throws ValidationError before softDelete is called', async () => {
    const ctx = makeCtx();
    await expect(
      handleCustomerDeleted(
        ctx,
        makeRow(
          'customer.deleted',
          customerPayload({ topic: 'customers/delete', webhookId: 'wh-bad', shopifyCustomerId: 'abc' }),
        ),
      ),
    ).rejects.toThrow();
    expect(mocks.softDelete).not.toHaveBeenCalled();
    expect(mocks.recompute).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Envelope validation
// ===========================================================================

describe('customer envelope validation', () => {
  it('handleCustomerCreated: missing body → ZodError, no repo or scoring call', async () => {
    const ctx = makeCtx();
    await expect(
      handleCustomerCreated(
        ctx,
        makeRow('customer.created', { topic: 'customers/create', webhookId: 'wh' }),
      ),
    ).rejects.toThrow();
    expect(mocks.upsertFromWebhook).not.toHaveBeenCalled();
    expect(mocks.recompute).not.toHaveBeenCalled();
  });

  it('handleCustomerDeleted: missing topic → ZodError, no softDelete call', async () => {
    const ctx = makeCtx();
    await expect(
      handleCustomerDeleted(
        ctx,
        makeRow('customer.deleted', { webhookId: 'wh', body: { id: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' } }),
      ),
    ).rejects.toThrow();
    expect(mocks.softDelete).not.toHaveBeenCalled();
  });
});
