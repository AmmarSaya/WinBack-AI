/**
 * `pnpm cli:outbox:replay <eventId> --reason "<text>"`
 *
 * Operator command to requeue a dead-lettered OutboxEvent.
 *
 * Algorithm:
 *
 *   withSystemScope('outbox.replay', async () => {
 *     prisma.$transaction(async (tx) => {
 *       1. findUnique by eventId (joined with merchant for shop name).
 *          null → 'not_found' (CLI exits 2).
 *       2. outbox.requeueDeadLettered(tx, eventId).
 *          wasDeadLettered: false → 'not_in_dlq' (CLI exits 3).
 *       3. auditLog.append(action: outbox.replay, ..., tx).
 *       4. Commit. Return 'replayed'.
 *     });
 *   });
 *
 * All three writes share the same transaction. If the audit write fails,
 * the requeue rolls back — operator gets a clean error and the row stays
 * dead-lettered.
 *
 * Idempotency: a replay on a row that's NOT in DLQ state (e.g. operator
 * raced two replays) returns 'not_in_dlq' rather than no-op-succeeding.
 * The CLI's exit-code 3 surfaces the unexpected state.
 */

import { AUDIT_ACTIONS, SYSTEM_SCOPE_REASONS } from '@winback/contracts';
import {
  AuditLogRepository,
  OutboxRepository,
  type WinbackPrisma,
  withSystemScope,
} from '@winback/db';
import type { Prisma } from '@prisma/client';

export interface EventSummary {
  readonly id: string;
  readonly merchantId: string;
  readonly type: string;
  readonly shop: string;
}

export type ReplayResult =
  | { kind: 'not_found' }
  | { kind: 'not_in_dlq'; event: EventSummary }
  | { kind: 'replayed'; event: EventSummary };

export interface ReplayArgs {
  readonly prisma: WinbackPrisma;
  readonly eventId: string;
  readonly reason: string;
  readonly actorId: string;
}

export async function replayEvent(args: ReplayArgs): Promise<ReplayResult> {
  const { prisma, eventId, reason, actorId } = args;

  return withSystemScope(SYSTEM_SCOPE_REASONS.outbox.replay, async () => {
    return prisma.$transaction(async (extendedTx) => {
      const tx = extendedTx as unknown as Prisma.TransactionClient;

      // 1. Locate the row. Join Merchant for shop (denormalized into the
      // AuditLog row for forensic survival post-merchant-deletion).
      const event = await tx.outboxEvent.findUnique({
        where: { id: eventId },
        select: {
          id: true,
          merchantId: true,
          type: true,
          merchant: { select: { shop: true } },
        },
      });

      if (event === null) {
        return { kind: 'not_found' };
      }

      const summary: EventSummary = {
        id: event.id,
        merchantId: event.merchantId,
        type: event.type,
        shop: event.merchant.shop,
      };

      // 2. Requeue (guarded). `wasDeadLettered: false` means the row
      // exists but isn't in DLQ state — operator gets a clear "not in
      // target state" signal rather than a silent no-op.
      //
      // Repos constructed with outer `prisma`; all writes use the
      // passed `tx`. If a future repo method uses `this.prisma` instead
      // of the supplied tx, the write would bypass this transaction.
      const outboxRepo = new OutboxRepository(prisma);
      const { wasDeadLettered } = await outboxRepo.requeueDeadLettered(tx, eventId);

      if (!wasDeadLettered) {
        return { kind: 'not_in_dlq', event: summary };
      }

      // 3. AuditLog row in the same tx. `actorType: 'operator'`,
      // `actorId` from the calling process's USER/USERNAME env (forensic
      // capture, not authoritative auth). `targetType: 'outbox_event'`,
      // `targetId` = the event id. `context.reason` is the operator-
      // supplied justification, captured verbatim.
      const auditRepo = new AuditLogRepository(prisma);
      await auditRepo.append(
        {
          merchantId: summary.merchantId,
          shop: summary.shop,
          actorType: 'operator',
          actorId,
          action: AUDIT_ACTIONS.outbox.replay,
          targetType: 'outbox_event',
          targetId: eventId,
          context: { reason, eventType: summary.type },
        },
        tx,
      );

      return { kind: 'replayed', event: summary };
    });
  });
}
