/**
 * Unit tests for `runDrainTick`.
 *
 * Focus is on the loop's per-row semantics:
 *   - normal path: dispatch + markProcessed (success) or markFailed (throw)
 *   - MARK_BEFORE_INVOKE path: markProcessed BEFORE dispatch, dispatch
 *     runs OUT of drainer tx (phase 2)
 *   - hasMore math: claimed === batchSize ⇔ hasMore=true
 *   - poison message containment: one row's throw doesn't tank the rest
 *
 * No real Prisma, no real Redis, no real handlers. The repository +
 * dispatcher are injected via RunDrainTickOptions test seams.
 */

import { OUTBOX_EVENTS } from '@winback/contracts';
import type { OutboxEventRow, OutboxRepository } from '@winback/db';
import { describe, expect, it, vi } from 'vitest';

import type { DrainerContext } from '../src/context.js';
import { runDrainTick } from '../src/drainer.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    id: 'row-' + Math.random().toString(36).slice(2, 8),
    merchantId: 'merchant-1',
    type: OUTBOX_EVENTS.customer.created,
    payload: {},
    createdAt: new Date(),
    attempts: 0,
    ...overrides,
  };
}

interface StubRepo {
  claimBatch: ReturnType<typeof vi.fn>;
  markProcessed: ReturnType<typeof vi.fn>;
  markFailed: ReturnType<typeof vi.fn>;
}

function makeStubRepo(rowsToReturn: OutboxEventRow[]): StubRepo {
  return {
    claimBatch: vi.fn().mockResolvedValue(rowsToReturn),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  };
}

function makeStubContext(repo: StubRepo): DrainerContext {
  // The drainer's prisma.$transaction is awaited; the callback receives
  // a tx client. We pass a sentinel — the stub repo doesn't look at it.
  const tx = { __tx: true };
  return {
    prisma: {
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    } as unknown as DrainerContext['prisma'],
    queues: {} as DrainerContext['queues'],
    shopifyConfig: {} as DrainerContext['shopifyConfig'],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runDrainTick — happy path', () => {
  it('claims rows, dispatches each, marks each processed', async () => {
    const rows = [
      makeRow({ id: 'a', type: OUTBOX_EVENTS.customer.created }),
      makeRow({ id: 'b', type: OUTBOX_EVENTS.product.updated }),
      makeRow({ id: 'c', type: OUTBOX_EVENTS.customer.state_changed }),
    ];
    const repo = makeStubRepo(rows);
    const ctx = makeStubContext(repo);
    const dispatch = vi.fn().mockResolvedValue(undefined);

    const result = await runDrainTick(ctx, {
      batchSize: 10,
      outbox: repo as unknown as OutboxRepository,
      dispatch,
    });

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(repo.markProcessed).toHaveBeenCalledTimes(3);
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(result).toEqual({ claimed: 3, hasMore: false });
  });

  it('hasMore=true when batch is exactly full', async () => {
    const rows = [makeRow(), makeRow()];
    const repo = makeStubRepo(rows);
    const ctx = makeStubContext(repo);

    const result = await runDrainTick(ctx, {
      batchSize: 2,
      outbox: repo as unknown as OutboxRepository,
      dispatch: vi.fn().mockResolvedValue(undefined),
    });

    expect(result).toEqual({ claimed: 2, hasMore: true });
  });

  it('empty batch returns claimed=0, hasMore=false', async () => {
    const repo = makeStubRepo([]);
    const ctx = makeStubContext(repo);

    const result = await runDrainTick(ctx, {
      batchSize: 100,
      outbox: repo as unknown as OutboxRepository,
      dispatch: vi.fn(),
    });

    expect(result).toEqual({ claimed: 0, hasMore: false });
    expect(repo.markProcessed).not.toHaveBeenCalled();
  });
});

describe('runDrainTick — poison message containment', () => {
  it('one row that throws → markFailed; other rows still markProcessed', async () => {
    const rows = [
      makeRow({ id: 'good-1', type: OUTBOX_EVENTS.customer.created }),
      makeRow({ id: 'bad', type: OUTBOX_EVENTS.product.updated }),
      makeRow({ id: 'good-2', type: OUTBOX_EVENTS.customer.state_changed }),
    ];
    const repo = makeStubRepo(rows);
    const ctx = makeStubContext(repo);
    const dispatch = vi.fn().mockImplementation(async (_ctx, row: OutboxEventRow) => {
      if (row.id === 'bad') throw new Error('handler boom');
    });

    const result = await runDrainTick(ctx, {
      batchSize: 10,
      outbox: repo as unknown as OutboxRepository,
      dispatch,
    });

    expect(result.claimed).toBe(3);
    expect(repo.markProcessed).toHaveBeenCalledTimes(2);
    expect(repo.markFailed).toHaveBeenCalledTimes(1);
    expect(repo.markFailed).toHaveBeenCalledWith(expect.anything(), 'bad', 'handler boom');
  });
});

describe('runDrainTick — MARK_BEFORE_INVOKE ordering', () => {
  it('gdpr.shop_redacted: markProcessed BEFORE dispatch is invoked', async () => {
    const row = makeRow({ id: 'shop-redact', type: OUTBOX_EVENTS.gdpr.shop_redacted });
    const repo = makeStubRepo([row]);
    const ctx = makeStubContext(repo);

    // Record the call order: markProcessed vs dispatch.
    const callOrder: string[] = [];
    repo.markProcessed.mockImplementation(async () => {
      callOrder.push('markProcessed');
    });
    const dispatch = vi.fn().mockImplementation(async () => {
      callOrder.push('dispatch');
    });

    await runDrainTick(ctx, {
      batchSize: 10,
      outbox: repo as unknown as OutboxRepository,
      dispatch,
    });

    expect(callOrder).toEqual(['markProcessed', 'dispatch']);
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it('merchant.installed: same MBI ordering as shop_redacted', async () => {
    const row = makeRow({ id: 'merch-install', type: OUTBOX_EVENTS.merchant.installed });
    const repo = makeStubRepo([row]);
    const ctx = makeStubContext(repo);

    const callOrder: string[] = [];
    repo.markProcessed.mockImplementation(async () => {
      callOrder.push('markProcessed');
    });
    const dispatch = vi.fn().mockImplementation(async () => {
      callOrder.push('dispatch');
    });

    await runDrainTick(ctx, {
      batchSize: 10,
      outbox: repo as unknown as OutboxRepository,
      dispatch,
    });

    expect(callOrder).toEqual(['markProcessed', 'dispatch']);
  });

  it('MBI handler throw: row stays marked processed (no markFailed)', async () => {
    const row = makeRow({ id: 'mbi-throws', type: OUTBOX_EVENTS.merchant.installed });
    const repo = makeStubRepo([row]);
    const ctx = makeStubContext(repo);
    const dispatch = vi.fn().mockRejectedValue(new Error('phase 2 failure'));

    // Should not throw out of runDrainTick — MBI throws are logged + swallowed.
    await expect(
      runDrainTick(ctx, {
        batchSize: 10,
        outbox: repo as unknown as OutboxRepository,
        dispatch,
      }),
    ).resolves.toMatchObject({ claimed: 1 });

    expect(repo.markProcessed).toHaveBeenCalledTimes(1);
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it('mixed batch: non-MBI rows dispatched in-tx, MBI deferred to phase 2', async () => {
    const rows = [
      makeRow({ id: 'normal', type: OUTBOX_EVENTS.customer.created }),
      makeRow({ id: 'mbi', type: OUTBOX_EVENTS.merchant.installed }),
      makeRow({ id: 'normal-2', type: OUTBOX_EVENTS.product.updated }),
    ];
    const repo = makeStubRepo(rows);
    const ctx = makeStubContext(repo);

    const dispatchOrder: string[] = [];
    const dispatch = vi.fn().mockImplementation(async (_ctx, row: OutboxEventRow) => {
      dispatchOrder.push(row.id);
    });

    await runDrainTick(ctx, {
      batchSize: 10,
      outbox: repo as unknown as OutboxRepository,
      dispatch,
    });

    // Phase 1: 'normal' + 'normal-2' dispatched in-tx (in row order),
    // 'mbi' deferred. Phase 2: 'mbi' dispatched after.
    expect(dispatchOrder).toEqual(['normal', 'normal-2', 'mbi']);
    expect(repo.markProcessed).toHaveBeenCalledTimes(3);
  });
});
