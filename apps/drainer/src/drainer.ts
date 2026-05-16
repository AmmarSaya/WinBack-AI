/**
 * Drainer tick — the per-tick claim + dispatch loop.
 *
 * Algorithm:
 *
 *   withSystemScope('outbox.drain', async () => {
 *     // Phase 1: in-tx work.
 *     const deferred = [];
 *     await prisma.$transaction(async (tx) => {
 *       const rows = await outbox.claimBatch(tx, batchSize);
 *       for (row of rows) {
 *         if (MARK_BEFORE_INVOKE_EVENTS.has(row.type)) {
 *           await outbox.markProcessed(tx, row.id);   // mark now
 *           deferred.push(row);                        // defer handler
 *         } else {
 *           try   { await dispatch(row); await outbox.markProcessed(tx, row.id); }
 *           catch { await outbox.markFailed(tx, row.id, err); }
 *         }
 *       }
 *     });   // drainer tx commits — locks release.
 *
 *     // Phase 2: deferred handlers run OUT of drainer tx.
 *     for (row of deferred) {
 *       try { await dispatch(row); }
 *       catch { log.error('deferred handler failed; row already marked'); }
 *     }
 *
 *     return { claimed, hasMore: claimed === batchSize };
 *   });
 *
 * The per-row try/catch in Phase 1 ensures one poison message doesn't
 * tank the entire batch — failed rows get markFailed (attempts++,
 * lastError captured) and stay claimable for retry. The tx commits with
 * a mix of processed + failed rows.
 *
 * Phase 2 deferred handlers (MARK_BEFORE_INVOKE_EVENTS) run after the
 * drainer tx commits. Throws are logged but do not affect the already-
 * marked-processed row state — see `./ordering.ts` for the trade-off.
 *
 * SYSTEM_SCOPE_REASONS.outbox.drain is registered AT this call site
 * (per standing rule 36) — the registration in
 * @winback/contracts/src/system-scope-reasons.ts ships in the same
 * commit as this file.
 */

import { SYSTEM_SCOPE_REASONS, type OutboxEventType } from '@winback/contracts';
import {
  OutboxRepository,
  type OutboxEventRow,
  withSystemScope,
} from '@winback/db';
import { getLogger } from '@winback/logger';
import type { Prisma } from '@prisma/client';

import type { DrainerContext } from './context.js';
import { dispatchEvent } from './dispatch.js';
import { MARK_BEFORE_INVOKE_EVENTS } from './ordering.js';

const log = getLogger('drainer');

export const DEFAULT_BATCH_SIZE = 100;

export interface RunDrainTickResult {
  readonly claimed: number;
  readonly hasMore: boolean;
}

export interface RunDrainTickOptions {
  /** Defaults to DEFAULT_BATCH_SIZE (100). */
  readonly batchSize?: number;
  /** Test seam — inject a stub repository. */
  readonly outbox?: OutboxRepository;
  /** Test seam — inject a stub dispatcher. */
  readonly dispatch?: typeof dispatchEvent;
}

export async function runDrainTick(
  ctx: DrainerContext,
  options: RunDrainTickOptions = {},
): Promise<RunDrainTickResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const outbox = options.outbox ?? new OutboxRepository(ctx.prisma);
  const dispatch = options.dispatch ?? dispatchEvent;

  return withSystemScope(SYSTEM_SCOPE_REASONS.outbox.drain, async () => {
    const deferredRows: OutboxEventRow[] = [];
    let claimed = 0;

    await ctx.prisma.$transaction(async (extendedTx) => {
      // Prisma 5 typing gap: $transaction's callback param is the extended
      // client, NOT Prisma.TransactionClient. Repository methods expect
      // the unextended TransactionClient shape. Same cast pattern as
      // packages/shopify/src/install.ts:74 and UnitOfWork's internals.
      const tx = extendedTx as unknown as Prisma.TransactionClient;

      const rows = await outbox.claimBatch(tx, batchSize);
      claimed = rows.length;

      for (const row of rows) {
        if (MARK_BEFORE_INVOKE_EVENTS.has(row.type as OutboxEventType)) {
          // Mark in-tx; defer handler invocation to post-tx (Phase 2).
          await outbox.markProcessed(tx, row.id);
          deferredRows.push(row);
          continue;
        }

        try {
          await dispatch(ctx, row);
          await outbox.markProcessed(tx, row.id);
        } catch (err) {
          const errStr = err instanceof Error ? err.message : String(err);
          log.error(
            { err, eventId: row.id, type: row.type, merchantId: row.merchantId },
            'drainer: dispatch failed; markFailed',
          );
          await outbox.markFailed(tx, row.id, errStr);
        }
      }
    });

    // Phase 2: deferred handlers run OUT of drainer tx. The OutboxEvent
    // rows are already marked processed; throws here are logged for
    // forensic correlation but the row state is fixed. Future D4 DLQ
    // turns these throws into replayable failures; for D2 the recovery
    // path is manual operator re-invocation (handlers are idempotent
    // by design — see ./ordering.ts).
    for (const row of deferredRows) {
      try {
        await dispatch(ctx, row);
      } catch (err) {
        log.error(
          { err, eventId: row.id, type: row.type, merchantId: row.merchantId },
          'drainer: deferred handler failed (row already marked processed; D4 DLQ recovery)',
        );
      }
    }

    return {
      claimed,
      hasMore: claimed === batchSize,
    };
  });
}
