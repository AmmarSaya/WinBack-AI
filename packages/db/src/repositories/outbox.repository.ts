import type { OutboxEventType } from '@winback/contracts';
import type { Prisma } from '@prisma/client';

import type { WinbackPrisma } from '../client.js';
import { assertScopeMatchesMerchant, getTenantScope } from '../tenant-scope.js';

export interface OutboxEventRow {
  readonly id: string;
  readonly merchantId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: Date;
  readonly attempts: number;
}

/**
 * Outbox repository — used by the outbox drainer (D2) and rarely by
 * application code (which publishes via UnitOfWorkContext.publish instead).
 *
 * The drainer pattern:
 *   while (running) {
 *     const batch = await outbox.claimBatch(100);
 *     for (const ev of batch) {
 *       await bullmq.enqueue(ev.type, ev.payload);
 *       await outbox.markProcessed(ev.id);
 *     }
 *   }
 *
 * `claimBatch` uses `FOR UPDATE SKIP LOCKED` so multiple drainer replicas
 * don't double-process. The partial index from B2 T2 keeps the scan tight.
 */
export class OutboxRepository {
  constructor(private readonly prisma: WinbackPrisma) {}

  /**
   * Publishes an event OUTSIDE any active transaction. For events that must
   * be atomic with a business write, use `UnitOfWorkContext.publish` inside
   * a `UnitOfWork.run` callback instead.
   */
  async publishStandalone(
    merchantId: string,
    type: OutboxEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    assertScopeMatchesMerchant(merchantId);
    await this.prisma.outboxEvent.create({
      data: { merchantId, type, payload: payload as Prisma.InputJsonValue },
    });
  }

  /**
   * Claim a batch of unprocessed events for delivery. Caller MUST be in
   * system scope — the drainer crosses tenants by design.
   *
   * Returns up to `limit` events sorted by createdAt asc. Rows are locked
   * (FOR UPDATE SKIP LOCKED) until the surrounding transaction commits, so
   * other drainer replicas skip them.
   *
   * NOTE: callers must wrap this in `prisma.$transaction` so the
   * row-level locks are released only after `markProcessed` / `markFailed`
   * is called. The drainer typically processes a batch end-to-end in one
   * transaction.
   */
  async claimBatch(tx: Prisma.TransactionClient, limit = 100): Promise<OutboxEventRow[]> {
    const scope = getTenantScope();
    if (scope?.kind !== 'system') {
      throw new Error('OutboxRepository.claimBatch requires system scope');
    }
    // Raw SQL so we can use FOR UPDATE SKIP LOCKED, which the Prisma query
    // builder doesn't expose. Safe — no user input in the SQL string.
    return tx.$queryRaw<OutboxEventRow[]>`
      SELECT id, "merchantId", type, payload, "createdAt", attempts
      FROM "OutboxEvent"
      WHERE "processedAt" IS NULL
      ORDER BY "createdAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
  }

  async markProcessed(tx: Prisma.TransactionClient, id: string): Promise<void> {
    await tx.outboxEvent.update({
      where: { id },
      data: { processedAt: new Date() },
    });
  }

  async markFailed(
    tx: Prisma.TransactionClient,
    id: string,
    error: string,
  ): Promise<void> {
    await tx.outboxEvent.update({
      where: { id },
      data: { attempts: { increment: 1 }, lastError: error.slice(0, 1000) },
    });
  }
}
