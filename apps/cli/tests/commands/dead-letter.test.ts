/**
 * Unit tests for `forceDeadLetter`.
 *
 * Verifies each result-kind branch:
 *   - not_found             — findUnique returns null
 *   - already_dead_lettered — findUnique returns row, markDeadLettered
 *                             returns { wasAlreadyDeadLettered: true }
 *   - dead_lettered         — findUnique returns row, markDeadLettered
 *                             returns { wasAlreadyDeadLettered: false },
 *                             audit row written
 *
 * Mirrors the `replay.test.ts` mock pattern.
 */

import { AUDIT_ACTIONS } from '@winback/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';


vi.mock('@winback/db', async () => {
  const actual = await vi.importActual<typeof import('@winback/db')>('@winback/db');
  return {
    ...actual,
    OutboxRepository: vi.fn().mockImplementation(() => ({
      markDeadLettered: vi.fn().mockResolvedValue({ wasAlreadyDeadLettered: false }),
    })),
    AuditLogRepository: vi.fn().mockImplementation(() => ({
      append: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

const dbMod = await import('@winback/db');
const { forceDeadLetter } = await import('../../src/commands/dead-letter.js');

interface MockEvent {
  id: string;
  merchantId: string;
  type: string;
  merchant: { shop: string };
}

function makeStubPrisma(eventLookupReturns: MockEvent | null): {
  prisma: Parameters<typeof forceDeadLetter>[0]['prisma'];
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
    prisma: { $transaction } as unknown as Parameters<typeof forceDeadLetter>[0]['prisma'],
    findUnique,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('forceDeadLetter — happy path', () => {
  it('dead-letters an active event and writes the AuditLog row in the same tx', async () => {
    const markMock = vi.fn().mockResolvedValue({ wasAlreadyDeadLettered: false });
    const appendMock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(dbMod.OutboxRepository).mockImplementationOnce(
      () => ({ markDeadLettered: markMock }) as unknown as InstanceType<
        typeof dbMod.OutboxRepository
      >,
    );
    vi.mocked(dbMod.AuditLogRepository).mockImplementationOnce(
      () => ({ append: appendMock }) as unknown as InstanceType<typeof dbMod.AuditLogRepository>,
    );

    const { prisma } = makeStubPrisma({
      id: 'evt_stuck',
      merchantId: 'merchant-1',
      type: 'order.placed',
      merchant: { shop: 'foo.myshopify.com' },
    });

    const result = await forceDeadLetter({
      prisma,
      eventId: 'evt_stuck',
      reason: 'Shopify returns 422 — payload malformed',
      actorId: 'alice',
    });

    expect(result.kind).toBe('dead_lettered');
    if (result.kind === 'dead_lettered') {
      expect(result.event.merchantId).toBe('merchant-1');
    }

    expect(markMock).toHaveBeenCalledWith(
      expect.anything(),
      'evt_stuck',
      // markDeadLettered receives the prefix-decorated error message.
      'operator-forced: Shopify returns 422 — payload malformed',
    );
    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(appendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId: 'merchant-1',
        shop: 'foo.myshopify.com',
        actorType: 'operator',
        actorId: 'alice',
        action: AUDIT_ACTIONS.outbox.dead_letter_forced,
        targetType: 'outbox_event',
        targetId: 'evt_stuck',
        context: expect.objectContaining({
          reason: 'Shopify returns 422 — payload malformed',
          eventType: 'order.placed',
        }),
      }),
      expect.anything(),
    );
  });
});

describe('forceDeadLetter — not_found', () => {
  it('returns not_found when findUnique returns null; OutboxRepository never constructed', async () => {
    // Deliberately NO mockImplementationOnce calls here — same reason
    // as in replay.test.ts: unused queued once-impls would leak to
    // the next test (vi.clearAllMocks clears call history only,
    // not the mockImplementationOnce queue).
    const { prisma } = makeStubPrisma(null);

    const result = await forceDeadLetter({
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

describe('forceDeadLetter — already_dead_lettered', () => {
  it('returns already_dead_lettered when markDeadLettered returns wasAlreadyDeadLettered: true; no audit', async () => {
    const markMock = vi.fn().mockResolvedValue({ wasAlreadyDeadLettered: true });
    const appendMock = vi.fn();
    vi.mocked(dbMod.OutboxRepository).mockImplementationOnce(
      () => ({ markDeadLettered: markMock }) as unknown as InstanceType<
        typeof dbMod.OutboxRepository
      >,
    );
    vi.mocked(dbMod.AuditLogRepository).mockImplementationOnce(
      () => ({ append: appendMock }) as unknown as InstanceType<typeof dbMod.AuditLogRepository>,
    );

    const { prisma } = makeStubPrisma({
      id: 'evt_dlq',
      merchantId: 'merchant-1',
      type: 'order.placed',
      merchant: { shop: 'foo.myshopify.com' },
    });

    const result = await forceDeadLetter({
      prisma,
      eventId: 'evt_dlq',
      reason: 'tried to force-dlq but already there',
      actorId: 'alice',
    });

    expect(result.kind).toBe('already_dead_lettered');
    expect(markMock).toHaveBeenCalledTimes(1);
    expect(appendMock).not.toHaveBeenCalled();
  });
});
