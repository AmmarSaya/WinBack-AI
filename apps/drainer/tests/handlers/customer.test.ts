/**
 * Unit tests for the post-Epic-E-session-1 customer handlers.
 *
 * Same mocking strategy as order.test.ts: vi.mock + vi.hoisted to
 * replace `CustomerRepository` + pass-through `withTenantScope`. Real-DB
 * coverage in batch 5's drainer integration harness extension.
 */

import type { OutboxEventRow } from '@winback/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DrainerContext } from '../../src/context.js';

const mocks = vi.hoisted(() => ({
  upsertFromWebhook: vi.fn().mockResolvedValue({
    customerId: 'cust_local_1',
    isNewCustomer: true,
  }),
  softDelete: vi.fn().mockResolvedValue({ existed: true }),
}));

vi.mock('@winback/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@winback/db')>();
  return {
    ...actual,
    CustomerRepository: vi.fn().mockImplementation(() => ({
      upsertFromWebhook: mocks.upsertFromWebhook,
      softDelete: mocks.softDelete,
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

beforeEach(() => {
  mocks.upsertFromWebhook.mockResolvedValue({
    customerId: 'cust_local_1',
    isNewCustomer: true,
  });
  mocks.softDelete.mockResolvedValue({ existed: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// handleCustomerCreated + handleCustomerUpdated
// ---------------------------------------------------------------------------

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
    const call = mocks.upsertFromWebhook.mock.calls[0][0];
    expect(call.merchantId).toBe('merchant-1');
    expect(call.body.id).toBe(42);
    expect(call.tx).toBeDefined();
  });

  it('repository throw propagates to caller', async () => {
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
    expect(mocks.upsertFromWebhook.mock.calls[0][0].body.id).toBe(77);
  });
});

// ---------------------------------------------------------------------------
// handleCustomerDeleted
// ---------------------------------------------------------------------------

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
    const call = mocks.softDelete.mock.calls[0][0];
    expect(call.merchantId).toBe('merchant-1');
    expect(call.shopifyCustomerId).toBe('gid://shopify/Customer/555');
    expect(call.tx).toBeDefined();
  });

  it('existed=false (already-deleted or absent) → returns without throwing (idempotent)', async () => {
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
  });
});

// ---------------------------------------------------------------------------
// Envelope validation (parse fires BEFORE any repository call)
// ---------------------------------------------------------------------------

describe('customer envelope validation', () => {
  it('handleCustomerCreated: missing body → ZodError, no repo call', async () => {
    const ctx = makeCtx();
    await expect(
      handleCustomerCreated(
        ctx,
        makeRow('customer.created', { topic: 'customers/create', webhookId: 'wh' }),
      ),
    ).rejects.toThrow();
    expect(mocks.upsertFromWebhook).not.toHaveBeenCalled();
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
