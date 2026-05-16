/**
 * Unit tests for `replayEvent`.
 *
 * Verifies each result-kind branch:
 *   - not_found        — findUnique returns null
 *   - not_in_dlq       — findUnique returns row, requeueDeadLettered
 *                        returns { wasDeadLettered: false }
 *   - replayed         — findUnique returns row, requeueDeadLettered
 *                        returns { wasDeadLettered: true }, audit row written
 *
 * Mocks @winback/db's OutboxRepository + AuditLogRepository at the
 * module boundary. The findUnique call is mocked on the prisma stub.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUDIT_ACTIONS } from '@winback/contracts';

vi.mock('@winback/db', async () => {
  const actual = await vi.importActual<typeof import('@winback/db')>('@winback/db');
  return {
    ...actual,
    OutboxRepository: vi.fn().mockImplementation(() => ({
      requeueDeadLettered: vi.fn().mockResolvedValue({ wasDeadLettered: true }),
    })),
    AuditLogRepository: vi.fn().mockImplementation(() => ({
      append: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

const dbMod = await import('@winback/db');
const { replayEvent } = await import('../../src/commands/replay.js');

interface MockEvent {
  id: string;
  merchantId: string;
  type: string;
  merchant: { shop: string };
}

function makeStubPrisma(eventLookupReturns: MockEvent | null): {
  prisma: Parameters<typeof replayEvent>[0]['prisma'];
  findUnique: ReturnType<typeof vi.fn>;
} {
  const findUnique = vi.fn().mockResolvedValue(eventLookupReturns);
  const tx = {
    outboxEvent: { findUnique },
  };
  const $transaction = vi.fn(
    async (cb: (tx: unknown) => Promise<unknown>) => cb(tx),
  );
  return {
    prisma: { $transaction } as unknown as Parameters<typeof replayEvent>[0]['prisma'],
    findUnique,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('replayEvent — happy path', () => {
  it('replays a dead-lettered event and writes the AuditLog row in the same tx', async () => {
    const requeueMock = vi.fn().mockResolvedValue({ wasDeadLettered: true });
    const appendMock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(dbMod.OutboxRepository).mockImplementationOnce(
      () => ({ requeueDeadLettered: requeueMock }) as unknown as InstanceType<
        typeof dbMod.OutboxRepository
      >,
    );
    vi.mocked(dbMod.AuditLogRepository).mockImplementationOnce(
      () => ({ append: appendMock }) as unknown as InstanceType<typeof dbMod.AuditLogRepository>,
    );

    const { prisma } = makeStubPrisma({
      id: 'evt_abc',
      merchantId: 'merchant-1',
      type: 'customer.created',
      merchant: { shop: 'foo.myshopify.com' },
    });

    const result = await replayEvent({
      prisma,
      eventId: 'evt_abc',
      reason: 'stale token, now fixed',
      actorId: 'alice',
    });

    expect(result.kind).toBe('replayed');
    if (result.kind === 'replayed') {
      expect(result.event.merchantId).toBe('merchant-1');
      expect(result.event.shop).toBe('foo.myshopify.com');
    }

    expect(requeueMock).toHaveBeenCalledWith(expect.anything(), 'evt_abc');
    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(appendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId: 'merchant-1',
        shop: 'foo.myshopify.com',
        actorType: 'operator',
        actorId: 'alice',
        action: AUDIT_ACTIONS.outbox.replay,
        targetType: 'outbox_event',
        targetId: 'evt_abc',
        context: { reason: 'stale token, now fixed', eventType: 'customer.created' },
      }),
      expect.anything(),
    );
  });
});

describe('replayEvent — not_found', () => {
  it('returns not_found when findUnique returns null; OutboxRepository never constructed', async () => {
    // Deliberately NO mockImplementationOnce calls here. The code
    // returns 'not_found' before constructing OutboxRepository or
    // AuditLogRepository, so any unused once-impls queued here would
    // leak to the next test (vi.clearAllMocks does NOT clear queued
    // mockImplementationOnce — only call history).
    const { prisma } = makeStubPrisma(null);

    const result = await replayEvent({
      prisma,
      eventId: 'nonexistent',
      reason: 'whatever',
      actorId: 'alice',
    });

    expect(result.kind).toBe('not_found');
    expect(vi.mocked(dbMod.OutboxRepository)).not.toHaveBeenCalled();
    expect(vi.mocked(dbMod.AuditLogRepository)).not.toHaveBeenCalled();
  });
});

describe('replayEvent — not_in_dlq', () => {
  it('returns not_in_dlq when requeueDeadLettered returns wasDeadLettered: false; no audit', async () => {
    const requeueMock = vi.fn().mockResolvedValue({ wasDeadLettered: false });
    const appendMock = vi.fn();
    vi.mocked(dbMod.OutboxRepository).mockImplementationOnce(
      () => ({ requeueDeadLettered: requeueMock }) as unknown as InstanceType<
        typeof dbMod.OutboxRepository
      >,
    );
    vi.mocked(dbMod.AuditLogRepository).mockImplementationOnce(
      () => ({ append: appendMock }) as unknown as InstanceType<typeof dbMod.AuditLogRepository>,
    );

    const { prisma } = makeStubPrisma({
      id: 'evt_active',
      merchantId: 'merchant-1',
      type: 'customer.updated',
      merchant: { shop: 'foo.myshopify.com' },
    });

    const result = await replayEvent({
      prisma,
      eventId: 'evt_active',
      reason: 'oops, was not in dlq',
      actorId: 'alice',
    });

    expect(result.kind).toBe('not_in_dlq');
    if (result.kind === 'not_in_dlq') {
      expect(result.event.id).toBe('evt_active');
    }
    expect(requeueMock).toHaveBeenCalledTimes(1);
    expect(appendMock).not.toHaveBeenCalled();
  });
});
