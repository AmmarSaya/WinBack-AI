/**
 * `pnpm cli:outbox:dead-letter <eventId> --reason "<text>"`
 *
 * Operator command to force a stuck OutboxEvent into DLQ state ahead of
 * the natural attempts ceiling. Useful when the operator has diagnosed
 * a permanent failure (Shopify returns 4xx legitimately, payload is
 * corrupt, etc.) and doesn't want to wait for `MAX_OUTBOX_ATTEMPTS`
 * retries to play out.
 *
 * Algorithm: mirrors `replay.ts` shape — findUnique → guarded mark →
 * AuditLog → commit. Same scope reason category (`outbox.dead_letter`).
 *
 * Idempotency: a force-DLQ on an already-DLQ'd row returns
 * 'already_dead_lettered' rather than no-op-succeeding. Distinct exit
 * code lets the operator know nothing happened.
 *
 * `lastError` written by `markDeadLettered` includes the
 * `"operator-forced: <reason>"` prefix so the column data itself shows
 * this was an operator action, not a drainer-side error capture.
 */

import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, SYSTEM_SCOPE_REASONS } from '@winback/contracts';
import {
  AuditLogRepository,
  OutboxRepository,
  type WinbackPrisma,
  withSystemScope,
} from '@winback/db';

import type { EventSummary } from './replay.js';

export type DeadLetterResult =
  | { kind: 'not_found' }
  | { kind: 'already_dead_lettered'; event: EventSummary }
  | { kind: 'dead_lettered'; event: EventSummary };

export interface DeadLetterArgs {
  readonly prisma: WinbackPrisma;
  readonly eventId: string;
  readonly reason: string;
  readonly actorId: string;
}

export async function forceDeadLetter(args: DeadLetterArgs): Promise<DeadLetterResult> {
  const { prisma, eventId, reason, actorId } = args;

  return withSystemScope(SYSTEM_SCOPE_REASONS.outbox.dead_letter, async () => {
    return prisma.$transaction(async (extendedTx) => {
      const tx = extendedTx as unknown as Prisma.TransactionClient;

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

      // Guarded markDeadLettered. `wasAlreadyDeadLettered: true` means
      // the row was already in DLQ — no transition, no AuditLog row,
      // no exit-0 success.
      //
      // Repos constructed with outer `prisma`; all writes use the
      // passed `tx`. If a future repo method uses `this.prisma` instead
      // of the supplied tx, the write would bypass this transaction.
      const outboxRepo = new OutboxRepository(prisma);
      const errorMessage = `operator-forced: ${reason}`;
      const { wasAlreadyDeadLettered } = await outboxRepo.markDeadLettered(
        tx,
        eventId,
        errorMessage,
      );

      if (wasAlreadyDeadLettered) {
        return { kind: 'already_dead_lettered', event: summary };
      }

      const auditRepo = new AuditLogRepository(prisma);
      await auditRepo.append(
        {
          merchantId: summary.merchantId,
          shop: summary.shop,
          actorType: 'operator',
          actorId,
          action: AUDIT_ACTIONS.outbox.dead_letter_forced,
          targetType: 'outbox_event',
          targetId: eventId,
          context: { reason, eventType: summary.type },
        },
        tx,
      );

      return { kind: 'dead_lettered', event: summary };
    });
  });
}
