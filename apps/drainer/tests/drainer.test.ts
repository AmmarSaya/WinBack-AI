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

import { MAX_OUTBOX_ATTEMPTS, OUTBOX_EVENTS } from '@winback/contracts';
import type { OutboxEventRow, OutboxRepository } from '@winback/db';
import { ValidationError } from '@winback/errors';
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
    deadLetteredAt: null,
    deferredFailedAt: null,
    ...overrides,
  };
}

interface StubRepo {
  claimBatch: ReturnType<typeof vi.fn>;
  markProcessed: ReturnType<typeof vi.fn>;
  markFailed: ReturnType<typeof vi.fn>;
  markDeadLettered: ReturnType<typeof vi.fn>;
  markDeferredFailed: ReturnType<typeof vi.fn>;
}

function makeStubRepo(rowsToReturn: OutboxEventRow[]): StubRepo {
  return {
    claimBatch: vi.fn().mockResolvedValue(rowsToReturn),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    markDeadLettered: vi.fn().mockResolvedValue(undefined),
    markDeferredFailed: vi.fn().mockResolvedValue(undefined),
  };
}

function makeStubContext(_repo: StubRepo): DrainerContext {
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
  it('one row that throws (retryable) → markFailed; other rows still markProcessed', async () => {
    const rows = [
      makeRow({ id: 'good-1', type: OUTBOX_EVENTS.customer.created }),
      makeRow({ id: 'bad', type: OUTBOX_EVENTS.product.updated }),
      makeRow({ id: 'good-2', type: OUTBOX_EVENTS.customer.state_changed }),
    ];
    const repo = makeStubRepo(rows);
    const ctx = makeStubContext(repo);
    // Plain Error is retryable (isRetryable returns true for non-AppError throws).
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
    expect(repo.markDeadLettered).not.toHaveBeenCalled();
  });
});

describe('runDrainTick — D4 DLQ logic (non-retryable error)', () => {
  it('non-retryable error → markDeadLettered immediately (NOT markFailed)', async () => {
    const row = makeRow({ id: 'bad', type: OUTBOX_EVENTS.product.updated, attempts: 0 });
    const repo = makeStubRepo([row]);
    const ctx = makeStubContext(repo);

    // ValidationError is a non-retryable AppError subclass.
    const dispatch = vi.fn().mockRejectedValue(
      new ValidationError('payload malformed'),
    );

    await runDrainTick(ctx, {
      batchSize: 10,
      outbox: repo as unknown as OutboxRepository,
      dispatch,
    });

    expect(repo.markDeadLettered).toHaveBeenCalledTimes(1);
    expect(repo.markDeadLettered).toHaveBeenCalledWith(
      expect.anything(),
      'bad',
      expect.stringContaining('payload malformed'),
    );
    expect(repo.markFailed).not.toHaveBeenCalled();
  });
});

describe('runDrainTick — D4 DLQ logic (attempts ceiling)', () => {
  it('attempts ceiling exhausted (attempts = MAX - 1, retryable error) → markDeadLettered', async () => {
    // row.attempts = 9 → nextAttempts = 10 → 10 >= MAX_OUTBOX_ATTEMPTS (10) → DLQ.
    const row = makeRow({
      id: 'last-chance',
      type: OUTBOX_EVENTS.product.updated,
      attempts: MAX_OUTBOX_ATTEMPTS - 1,
    });
    const repo = makeStubRepo([row]);
    const ctx = makeStubContext(repo);
    const dispatch = vi.fn().mockRejectedValue(new Error('transient'));

    await runDrainTick(ctx, {
      batchSize: 10,
      outbox: repo as unknown as OutboxRepository,
      dispatch,
    });

    expect(repo.markDeadLettered).toHaveBeenCalledTimes(1);
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it('attempts below ceiling (attempts = MAX - 2, retryable error) → markFailed (retry)', async () => {
    // row.attempts = 8 → nextAttempts = 9 → 9 < MAX_OUTBOX_ATTEMPTS (10) → retry.
    const row = makeRow({
      id: 'will-retry',
      type: OUTBOX_EVENTS.product.updated,
      attempts: MAX_OUTBOX_ATTEMPTS - 2,
    });
    const repo = makeStubRepo([row]);
    const ctx = makeStubContext(repo);
    const dispatch = vi.fn().mockRejectedValue(new Error('transient'));

    await runDrainTick(ctx, {
      batchSize: 10,
      outbox: repo as unknown as OutboxRepository,
      dispatch,
    });

    expect(repo.markFailed).toHaveBeenCalledTimes(1);
    expect(repo.markDeadLettered).not.toHaveBeenCalled();
  });

  it('off-by-one regression: attempts = 0 + retryable → markFailed (not DLQ)', async () => {
    // row.attempts = 0 → nextAttempts = 1 → 1 < 10 → retry, NOT DLQ.
    // If the code had used `row.attempts >= MAX` instead of
    // `row.attempts + 1 >= MAX`, this would still pass (0 < 10).
    // The boundary test below is the one that catches the off-by-one.
    const row = makeRow({ id: 'fresh', attempts: 0 });
    const repo = makeStubRepo([row]);
    const ctx = makeStubContext(repo);
    const dispatch = vi.fn().mockRejectedValue(new Error('transient'));

    await runDrainTick(ctx, {
      batchSize: 10,
      outbox: repo as unknown as OutboxRepository,
      dispatch,
    });

    expect(repo.markFailed).toHaveBeenCalledTimes(1);
    expect(repo.markDeadLettered).not.toHaveBeenCalled();
  });

  it('markDeadLettered returning wasAlreadyDeadLettered: true does not crash the drainer', async () => {
    // Theoretically unreachable under normal drainer operation
    // (SKIP LOCKED guarantees only one drainer claims a row, and
    // claimBatch excludes already-DLQ'd rows). But the return-type
    // contract is `{ wasAlreadyDeadLettered: boolean }`, so a future
    // refactor or unusual race shouldn't crash the loop if the flag
    // comes back true — the drainer ignores the return value because
    // the row was claimed-as-not-DLQ pre-call.
    const row = makeRow({ id: 'race-anomaly', attempts: 0 });
    const repo = makeStubRepo([row]);
    repo.markDeadLettered.mockResolvedValueOnce({ wasAlreadyDeadLettered: true });
    const ctx = makeStubContext(repo);
    // Non-retryable error → drainer routes to markDeadLettered.
    const dispatch = vi.fn().mockRejectedValue(new ValidationError('boom'));

    // Should not throw out of runDrainTick.
    await expect(
      runDrainTick(ctx, {
        batchSize: 10,
        outbox: repo as unknown as OutboxRepository,
        dispatch,
      }),
    ).resolves.toMatchObject({ claimed: 1 });

    expect(repo.markDeadLettered).toHaveBeenCalledTimes(1);
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

  it('MBI handler throw: row stays marked processed; D4 markDeferredFailed called (no markFailed)', async () => {
    const row = makeRow({ id: 'mbi-throws', type: OUTBOX_EVENTS.merchant.installed });
    const repo = makeStubRepo([row]);
    const ctx = makeStubContext(repo);
    const dispatch = vi.fn().mockRejectedValue(new Error('phase 2 failure'));

    // Should not throw out of runDrainTick — MBI throws are logged + marked.
    await expect(
      runDrainTick(ctx, {
        batchSize: 10,
        outbox: repo as unknown as OutboxRepository,
        dispatch,
      }),
    ).resolves.toMatchObject({ claimed: 1 });

    expect(repo.markProcessed).toHaveBeenCalledTimes(1);
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(repo.markDeadLettered).not.toHaveBeenCalled();
    // D4: Phase 2 failure → markDeferredFailed in separate tx.
    expect(repo.markDeferredFailed).toHaveBeenCalledTimes(1);
    expect(repo.markDeferredFailed).toHaveBeenCalledWith(
      expect.anything(),
      'mbi-throws',
      'phase 2 failure',
    );
  });

  it('MBI marker tx failure: logged + loop continues (no crash)', async () => {
    const row = makeRow({ id: 'mbi-doublefail', type: OUTBOX_EVENTS.merchant.installed });
    const repo = makeStubRepo([row]);
    repo.markDeferredFailed.mockRejectedValueOnce(new Error('DB down for marker tx'));
    const ctx = makeStubContext(repo);
    const dispatch = vi.fn().mockRejectedValue(new Error('phase 2 failure'));

    // Even with markDeferredFailed throwing, runDrainTick resolves.
    await expect(
      runDrainTick(ctx, {
        batchSize: 10,
        outbox: repo as unknown as OutboxRepository,
        dispatch,
      }),
    ).resolves.toMatchObject({ claimed: 1 });

    expect(repo.markProcessed).toHaveBeenCalledTimes(1);
    expect(repo.markDeferredFailed).toHaveBeenCalledTimes(1);
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
