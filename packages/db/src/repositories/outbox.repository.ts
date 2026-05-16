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
  /**
   * D4 — set when the drainer has dead-lettered the row (non-retryable
   * error OR attempts ceiling exhausted). `claimBatch` excludes rows
   * where this is set; operator CLI clears it back to null on replay.
   */
  readonly deadLetteredAt: Date | null;
  /**
   * D4 — set when a MARK_BEFORE_INVOKE_EVENTS Phase 2 deferred handler
   * threw AFTER the row was already marked processed. Forensic marker;
   * does not affect drainer claim eligibility (processedAt is set, so
   * the row is already terminal from the drainer's perspective).
   */
  readonly deferredFailedAt: Date | null;
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
    //
    // D4 predicate: excludes dead-lettered rows. Supported by the
    // `outbox_claimable_created_at` partial index (migration
    // 20260516130100). Without that index, the planner would scan
    // unprocessed rows and post-filter `deadLetteredAt IS NOT NULL` —
    // correct but unbounded as DLQ accumulates.
    return tx.$queryRaw<OutboxEventRow[]>`
      SELECT id, "merchantId", type, payload, "createdAt", attempts,
             "deadLetteredAt", "deferredFailedAt"
      FROM "OutboxEvent"
      WHERE "processedAt" IS NULL
        AND "deadLetteredAt" IS NULL
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

  /**
   * Terminal dead-letter for a row. Called by:
   *   - The drainer's Phase 1 catch when `!isRetryable(err) || attempts +
   *     1 >= MAX_OUTBOX_ATTEMPTS` (always on a freshly-claimed row, so
   *     `deadLetteredAt IS NULL` is guaranteed pre-call).
   *   - The operator CLI `pnpm cli:outbox:dead-letter` to force a stuck
   *     row into DLQ ahead of the natural ceiling.
   *
   * After this, `claimBatch` won't re-claim the row (predicate filters
   * `deadLetteredAt IS NULL`).
   *
   * Increments `attempts` for forensic completeness — the count reflects
   * the total dispatch attempts including the one that triggered DLQ.
   * `lastError` is set to the final-failure message, truncated to 1000
   * chars (same convention as markFailed).
   *
   * Guarded `updateMany` (`WHERE id = $1 AND deadLetteredAt IS NULL`):
   * the operator CLI can detect "already in DLQ" without a separate
   * findUnique query. Returns `wasAlreadyDeadLettered: true` when the
   * row exists but was already DLQ'd (or doesn't exist at all — caller
   * must disambiguate via a separate findUnique if it cares).
   *
   * Operator replay (`pnpm cli:outbox:replay`) clears `deadLetteredAt`
   * back to null and resets `attempts` to 0 — see `requeueDeadLettered`.
   *
   * Drainer call site: MUST be inside the same `prisma.$transaction` as
   * the `claimBatch` that produced the row, so the row lock holds across
   * the DLQ write. CLI call site: opens its own short tx wrapping the
   * paired `AuditLogRepository.append`.
   */
  async markDeadLettered(
    tx: Prisma.TransactionClient,
    id: string,
    error: string,
  ): Promise<{ wasAlreadyDeadLettered: boolean }> {
    const result = await tx.outboxEvent.updateMany({
      where: { id, deadLetteredAt: null },
      data: {
        deadLetteredAt: new Date(),
        attempts: { increment: 1 },
        lastError: error.slice(0, 1000),
      },
    });
    return { wasAlreadyDeadLettered: result.count === 0 };
  }

  /**
   * Forensic marker for a Phase 2 (MARK_BEFORE_INVOKE_EVENTS) handler
   * failure. The row was already marked processed in Phase 1 (per the
   * ordering policy — see apps/drainer/src/ordering.ts) and the
   * deferred handler invocation in Phase 2 threw.
   *
   * Does NOT increment `attempts`. Phase 2 is not retried by the
   * drainer; recovery is operator-driven (manual replay or operator
   * intervention; handlers are idempotent by design — BackfillJob
   * resumability, processShopRedact idempotency).
   *
   * Runs in a separate transaction from the drainer's Phase 1 tx,
   * because Phase 1 has already committed by the time Phase 2 executes.
   * The drainer wraps the call in its own `prisma.$transaction`.
   */
  async markDeferredFailed(
    tx: Prisma.TransactionClient,
    id: string,
    error: string,
  ): Promise<void> {
    await tx.outboxEvent.update({
      where: { id },
      data: {
        deferredFailedAt: new Date(),
        lastError: error.slice(0, 1000),
      },
    });
  }

  /**
   * Operator-driven replay: requeues a dead-lettered row by clearing
   * `deadLetteredAt` + resetting `attempts` to 0 + clearing `lastError`.
   * The drainer re-claims the row on its next tick.
   *
   * Reset semantics: operator asserts "this time it'll work" — the
   * retries-since-last-attempt count is irrelevant for the next pass.
   * The MAX_OUTBOX_ATTEMPTS ceiling applies fresh.
   *
   * `lastError` is cleared to null. **The prior failure message is NOT
   * preserved on the OutboxEvent row** — the paired AuditLog row written
   * by the CLI (with `action: 'outbox.replay'`, `context: { reason }`)
   * is the durable forensic record. If a replay itself fails, the new
   * `lastError` on the next markFailed/markDeadLettered overwrites the
   * cleared null; the audit trail in AuditLog retains the original-
   * failure → replay → next-failure timeline. Trade-off explicit so
   * future readers don't redesign this as a state-preservation hazard.
   *
   * MUST be called from system scope. The CLI command in `apps/cli`
   * opens `withSystemScope(SYSTEM_SCOPE_REASONS.outbox.replay, …)` and
   * writes the paired AuditLog row in the same transaction.
   *
   * Guarded `updateMany` (`WHERE id = $1 AND deadLetteredAt IS NOT
   * NULL`): the operator CLI can detect "row exists but isn't in DLQ"
   * (returns `wasDeadLettered: false`) without a separate query. The
   * caller still needs a findUnique to disambiguate "not found" from
   * "wrong state" if it cares about the distinction (the CLI does).
   */
  async requeueDeadLettered(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<{ wasDeadLettered: boolean }> {
    const result = await tx.outboxEvent.updateMany({
      where: { id, deadLetteredAt: { not: null } },
      data: {
        deadLetteredAt: null,
        // Direct set, NOT `{ increment: -n }`. Intentional asymmetry
        // with `markDeadLettered`'s `{ increment: 1 }`: replay is a
        // reset — operator asserts "start fresh." See docstring above.
        attempts: 0,
        lastError: null,
      },
    });
    return { wasDeadLettered: result.count > 0 };
  }
}
