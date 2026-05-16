/**
 * Per-event-type ordering policy for the drainer.
 *
 * Most events follow the standard flow:
 *
 *   prisma.$transaction(async (tx) => {
 *     rows = claimBatch(tx);
 *     for (row of rows) {
 *       try { dispatchEvent(row); markProcessed(tx, row.id); }
 *       catch { markFailed(tx, row.id, error); }
 *     }
 *   });   // tx commits; row locks release.
 *
 * Events listed in MARK_BEFORE_INVOKE_EVENTS deviate: markProcessed
 * runs inside the drainer tx BEFORE the handler is invoked, the tx
 * commits, and the handler then runs OUT of the drainer tx. The
 * dispatcher reads this Set per-row to decide which path to take.
 *
 * TWO REASONS an event lands in this Set (one mechanism, two motivations):
 *
 *   1. Cascade-prone (gdpr.shop_redacted)
 *
 *      The handler deletes the Merchant row, which CASCADEs every
 *      OutboxEvent for that tenant — including the row we're currently
 *      processing. Running markProcessed AFTER the handler would either
 *      fail (row gone — P2025) or write a phantom pre-cascade transient
 *      state. Mark-before-invoke + invoke-out-of-tx avoids both.
 *
 *   2. Long-running, lock-holding (merchant.installed)
 *
 *      enrichInstall + BackfillRunner.run are paged HTTP to Shopify.
 *      Customer backfill alone can take seconds-to-minutes for large
 *      stores. Inside the drainer tx, the OutboxEvent row lock is held
 *      for that full duration; other claimed rows in the same batch
 *      block too. Mark-before-invoke commits the drainer tx fast so the
 *      lock releases and other ticks/replicas can progress.
 *
 * TRADE-OFF (accepted for both reasons): handler crash AFTER markProcessed
 * means the OutboxEvent row is logically "done" but the actual work is
 * incomplete. Recovery paths until D4 ships a DLQ:
 *
 *   - gdpr.shop_redacted: idempotent. processShopRedact re-run on a
 *     fully-redacted-but-not-cascaded merchant resumes correctly
 *     because each step is idempotent. Operator runbook: manual
 *     re-invoke for the affected merchant.
 *
 *   - merchant.installed: BackfillJob state is persisted; runner.run
 *     resumes from the cursor on re-invocation. enrichInstall is an
 *     upsert. Idempotent re-run. D3 (cron sweep) handles the
 *     enrichment retry case as a separate owner.
 */

import { OUTBOX_EVENTS, type OutboxEventType } from '@winback/contracts';

export const MARK_BEFORE_INVOKE_EVENTS: ReadonlySet<OutboxEventType> = new Set<OutboxEventType>([
  OUTBOX_EVENTS.gdpr.shop_redacted,
  OUTBOX_EVENTS.merchant.installed,
]);
