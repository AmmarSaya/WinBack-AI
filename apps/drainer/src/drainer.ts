/**
 * Drainer tick — the per-tick claim + dispatch loop.
 *
 * Algorithm (D4):
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
 *           try {
 *             await dispatch(row);
 *             await outbox.markProcessed(tx, row.id);
 *           } catch (err) {
 *             const nextAttempts = row.attempts + 1;
 *             if (!isRetryable(err) || nextAttempts >= MAX_OUTBOX_ATTEMPTS) {
 *               await outbox.markDeadLettered(tx, row.id, err);
 *             } else {
 *               await outbox.markFailed(tx, row.id, err);
 *             }
 *           }
 *         }
 *       }
 *     });   // drainer tx commits — locks release.
 *
 *     // Phase 2: deferred handlers run OUT of drainer tx.
 *     for (row of deferred) {
 *       try { await dispatch(row); }
 *       catch (err) {
 *         // Row already marked processed (correctly per ordering policy).
 *         // Persist a forensic marker in a separate tx.
 *         await prisma.$transaction(tx2 => outbox.markDeferredFailed(tx2, row.id, err));
 *       }
 *     }
 *
 *     return { claimed, hasMore: claimed === batchSize };
 *   });
 *
 * The per-row try/catch in Phase 1 ensures one poison message doesn't
 * tank the entire batch. D4 changes the catch behavior:
 *   - Non-retryable errors → markDeadLettered (immediate, no retry).
 *   - Retryable errors past the attempts ceiling → markDeadLettered.
 *   - Retryable errors below the ceiling → markFailed (attempts++,
 *     lastError captured; row stays claimable for next tick).
 *
 * The ceiling comparison uses `row.attempts + 1` (the would-be next
 * value), NOT `row.attempts` (off-by-one would DLQ one attempt early).
 *
 * Phase 2 deferred handlers (MARK_BEFORE_INVOKE_EVENTS) run after the
 * drainer tx commits. Throws don't affect the already-marked-processed
 * row state (that's the policy — see `./ordering.ts`), but D4 adds a
 * forensic `deferredFailedAt` marker via a separate-tx
 * `markDeferredFailed` call. Operator surfaces these via SQL dashboard
 * queries for manual remediation (the handlers are idempotent).
 *
 * SYSTEM_SCOPE_REASONS.outbox.drain is registered AT this call site
 * (per standing rule 36) — the registration in
 * @winback/contracts/src/system-scope-reasons.ts shipped in D2.
 */

import type { Prisma } from '@prisma/client';
import {
  MAX_OUTBOX_ATTEMPTS,
  SYSTEM_SCOPE_REASONS,
  type OutboxEventType,
} from '@winback/contracts';
import {
  OutboxRepository,
  type OutboxEventRow,
  withSystemScope,
} from '@winback/db';
import { isRetryable } from '@winback/errors';
import { getLogger } from '@winback/logger';

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
          // D4: consult isRetryable + attempts ceiling. The would-be
          // next attempts value (row.attempts + 1) is the comparison
          // axis — comparing the stored pre-failure value would
          // DLQ one attempt too early (off-by-one).
          const nextAttempts = row.attempts + 1;
          const shouldDeadLetter =
            !isRetryable(err) || nextAttempts >= MAX_OUTBOX_ATTEMPTS;

          if (shouldDeadLetter) {
            log.error(
              {
                err,
                eventId: row.id,
                type: row.type,
                merchantId: row.merchantId,
                attempts: nextAttempts,
                reason: !isRetryable(err) ? 'non_retryable' : 'attempts_exhausted',
              },
              'drainer: dispatch failed; dead-lettering',
            );
            await outbox.markDeadLettered(tx, row.id, errStr);
          } else {
            log.error(
              {
                err,
                eventId: row.id,
                type: row.type,
                merchantId: row.merchantId,
                attempts: nextAttempts,
              },
              'drainer: dispatch failed; markFailed (will retry)',
            );
            await outbox.markFailed(tx, row.id, errStr);
          }
        }
      }
    });

    // Phase 2: deferred handlers run OUT of drainer tx. The OutboxEvent
    // rows are already marked processed; the throw doesn't reverse that
    // (correctly — the row's terminal state is "processed"). D4 adds a
    // separate forensic marker `deferredFailedAt` so operators can
    // surface "row processed but actual work failed" cases via SQL
    // dashboard queries.
    //
    // The marker write runs in its own short tx (the drainer tx has
    // already committed). Inner try/catch around `markDeferredFailed`
    // so a DB-side failure on the marker write doesn't terminate the
    // loop — we log it and move on. The dispatcher continues to the
    // next deferred row regardless.
    for (const row of deferredRows) {
      try {
        await dispatch(ctx, row);
      } catch (err) {
        const errStr = err instanceof Error ? err.message : String(err);
        log.error(
          { err, eventId: row.id, type: row.type, merchantId: row.merchantId },
          'drainer: deferred handler failed (row already marked processed)',
        );
        try {
          // ctx.prisma.$transaction, NOT tx — Phase 1 has committed; this
          // is a new independent tx. A rollback here doesn't (and
          // shouldn't) affect the already-processed row state.
          await ctx.prisma.$transaction(async (extendedMarkerTx) => {
            const markerTx = extendedMarkerTx as unknown as Prisma.TransactionClient;
            await outbox.markDeferredFailed(markerTx, row.id, errStr);
          });
        } catch (markErr) {
          log.error(
            { err: markErr, eventId: row.id, merchantId: row.merchantId },
            'drainer: failed to persist deferredFailedAt marker (forensic visibility lost)',
          );
        }
      }
    }

    return {
      claimed,
      hasMore: claimed === batchSize,
    };
  });
}
