import { randomUUID } from 'node:crypto';

import {
  Prisma,
  type CampaignTargetStatus,
  type EmailMarketingConsentState,
  type MessageChannel,
} from '@prisma/client';
import { AUDIT_ACTIONS } from '@winback/contracts';

import { AuditLogRepository } from './audit-log.repository.js';
import { BaseRepository } from './base.js';

/**
 * Repository for the Campaign dispatch pipeline (Epic G batch 8.2 — the
 * dispatch-worker skeleton). Two methods, the producer/consumer split of the
 * `dispatch-sweep` tick → `campaign.dispatch` worker flow:
 *
 *   - `findDispatchableDrafts` — the PICKUP. Run by the scheduler's
 *     `dispatch-sweep` tick (per merchant, under `withTenantScope`). Selects
 *     dispatch-eligible draft Messages, each paired with the winning active
 *     Campaign. The tick enqueues one `campaign.dispatch` job per row.
 *
 *   - `claimTarget` — the CLAIM. Run by the dispatch Worker per job. Creates
 *     the `CampaignTarget` (status=pending) that records "this draft was
 *     selected for this campaign." Idempotent on `CampaignTarget.messageId
 *     @unique` (a P2002 on replay returns `already_claimed`, never throws).
 *
 * v1 SKELETON BOUNDARY: this batch does NOT run the gate chain (8.3) or send
 * (8.4). The claim leaves `Message.status='draft'` untouched; the pending
 * `CampaignTarget` is the only state written. The gate chain + send batches
 * process the pending targets later.
 *
 * Raw SQL (the pickup) extends `BaseRepository` — `queryRawScoped` asserts the
 * active tenant scope matches `merchantId` before executing, because raw SQL
 * bypasses the Prisma extension's tenant assertion AND its soft-delete filter
 * (so the pickup's `Customer."deletedAt" IS NULL` predicate is written by hand).
 */

/**
 * Per-tick, per-merchant safety cap on the number of drafts claimed. A
 * pathological backlog won't flood `campaign.dispatch` in a single tick; the
 * remainder is picked up on the next 15-min `dispatch-sweep` (the `NOT EXISTS`
 * filter makes that re-pickup idempotent). The sweep handler LOGS when a
 * merchant hits this cap so the truncation is never silent.
 */
export const DEFAULT_DISPATCH_TAKE = 500;

/** One dispatch-eligible draft Message paired with its winning campaign. */
export interface DispatchableDraft {
  readonly messageId: string;
  readonly customerId: string;
  readonly campaignId: string;
}

export interface FindDispatchableDraftsArgs {
  readonly merchantId: string;
  readonly take?: number;
}

export interface ClaimTargetArgs {
  readonly merchantId: string;
  readonly campaignId: string;
  readonly messageId: string;
  readonly customerId: string;
}

/** `claimed` = this call created the target; `already_claimed` = P2002 no-op. */
export type ClaimTargetResult = 'claimed' | 'already_claimed';

/**
 * Everything the dispatch gate chain + the replay guard need for one target,
 * loaded in a single read (Epic G batch 8.3). `null` from `loadDispatchContext`
 * means the target (or its MerchantSettings) is gone — the worker no-ops (e.g.
 * the customer was GDPR-redacted since claim, cascade-deleting the target).
 */
export interface DispatchContext {
  /** Current target status — the REPLAY GUARD reads this before any gate runs. */
  readonly targetStatus: CampaignTargetStatus;
  readonly customerId: string;
  /** Consent gate — pass iff `subscribed`. */
  readonly consentState: EmailMarketingConsentState;
  /** Freshness gate `since` — the moment we decided to winback. */
  readonly generationCreatedAt: Date;
  /** Quiet-hours gate — IANA tz (null → UTC fallback + warn at the gate). */
  readonly timezone: string | null;
  readonly sendTimeStartHour: number;
  readonly sendTimeEndHour: number;
  readonly defaultCooldownHours: number;
  readonly maxDailySendsPerCustomer: number;
  readonly dailySendCap: number;
  readonly monthlySendsCap: number;
  /** Epic G batch 8.4 — recipient address for the SES send. Null when un-ingested. */
  readonly customerEmail: string | null;
  /** Epic G batch 8.4 — merchant `shop` (denormalized into AuditLog rows). */
  readonly shop: string;
  /** Epic G batch 8.4 — generated email body the SES send transmits. */
  readonly generatedText: string;
}

/** Quota pre-flight usage (8.3 read; 8.4 owns the authoritative under-lock increment). */
export interface QuotaUsage {
  readonly daySentCount: number;
  readonly monthSentCount: number;
}

/** A deferred target the dispatch sweep's arm 2 must resolve or re-enqueue. */
export interface DeferredTarget {
  readonly messageId: string;
  readonly campaignId: string;
  readonly customerId: string;
  /** Immutable claim time — the defer-age anchor (NOT `updatedAt`, which resets every re-entry). */
  readonly createdAt: Date;
  /** False → the owning campaign is no longer active (arm 2 resolves it, never re-enqueues). */
  readonly campaignActive: boolean;
}

export class CampaignRepository extends BaseRepository {
  /**
   * The dispatch PICKUP query. Returns up to `take` (default
   * `DEFAULT_DISPATCH_TAKE`) draft Messages eligible to dispatch for this
   * merchant, each paired with the winning Campaign.
   *
   * ELIGIBILITY (every predicate is load-bearing):
   *   - `Message.status = 'draft'` AND the parent `AiGeneration.status =
   *     'completed'` AND `Message.generatedText <> ''`. A draft alone is NOT
   *     dispatch-ready: `handleCustomerStateChanged` creates the Message with
   *     `status='draft', generatedText=''` BEFORE the LLM runs; the AI Worker
   *     fills `generatedText` only on completion and never changes
   *     `Message.status`. So `draft` covers pre-completion AND post-failure
   *     drafts — we gate on the generation having COMPLETED (authoritative)
   *     and a non-empty body (so the eventual send has content). This is the
   *     filter `message.repository.ts` flags for the dispatch worker.
   *   - An ACTIVE, EMAIL Campaign (same merchant) whose `triggerStates`
   *     contains the draft's band (`AiGeneration.triggerState`).
   *   - The Customer is not soft-deleted (`deletedAt IS NULL`) — raw SQL must
   *     enforce the soft-delete invariant by hand; a redacted customer must
   *     never be dispatched, and we do NOT rely on a downstream gate for that.
   *   - `NOT EXISTS` a `CampaignTarget` for the message — the idempotency
   *     pre-filter (skips already-claimed drafts; the `messageId @unique`
   *     constraint is the race backstop at claim time).
   *
   * TIEBREAK (locked 8.2): when >1 active campaign's `triggerStates` overlap a
   * draft's band, the OLDEST campaign wins — `DISTINCT ON (m.id)` keyed by
   * `ORDER BY m.id, c."createdAt" ASC, c."id" ASC`. `createdAt` is immutable
   * so a draft resolves to the SAME campaign across ticks (idempotency-safe);
   * `c."id"` is the final deterministic tiebreaker on a `createdAt` collision.
   * (Overlapping active campaigns is a merchant misconfiguration the
   * Campaign-CRUD batch should warn/prevent — this is the safety net.)
   *
   * Single-level `DISTINCT ON`, no outer-ordering conflict: job enqueue is
   * order-agnostic, so the leading `ORDER BY m.id` (required by `DISTINCT ON`)
   * doubles as the only ordering — no subquery wrap needed.
   */
  async findDispatchableDrafts(
    args: FindDispatchableDraftsArgs,
  ): Promise<readonly DispatchableDraft[]> {
    const { merchantId } = args;
    const take = args.take ?? DEFAULT_DISPATCH_TAKE;

    return this.queryRawScoped<DispatchableDraft>(
      merchantId,
      Prisma.sql`
        SELECT DISTINCT ON (m."id")
               m."id"         AS "messageId",
               m."customerId" AS "customerId",
               c."id"         AS "campaignId"
        FROM "Message" m
        JOIN "AiGeneration" ag
          ON ag."id" = m."aiGenerationId" AND ag."merchantId" = m."merchantId"
        JOIN "Customer" cust
          ON cust."id" = m."customerId" AND cust."merchantId" = m."merchantId"
        JOIN "Campaign" c
          ON c."merchantId" = m."merchantId"
         AND c."status"::text = 'active'
         AND c."channel"::text = 'email'
         AND ag."triggerState" = ANY (c."triggerStates")
        WHERE m."merchantId" = ${merchantId}
          AND m."status"::text = 'draft'
          AND ag."status"::text = 'completed'
          AND m."generatedText" <> ''
          AND cust."deletedAt" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "CampaignTarget" ct WHERE ct."messageId" = m."id"
          )
        ORDER BY m."id", c."createdAt" ASC, c."id" ASC
        LIMIT ${take}
      `,
    );
  }

  /**
   * The dispatch CLAIM. Creates the `CampaignTarget` (status=pending) for one
   * (campaign, message) pair. Caller MUST be inside `withTenantScope(merchantId)`
   * — the Prisma extension asserts the explicit `merchantId` matches the active
   * scope.
   *
   * IDEMPOTENCY: `CampaignTarget.messageId @unique` means a second claim for
   * the same message raises P2002 — caught here and returned as
   * `already_claimed` (a no-op). This is the race backstop behind the pickup's
   * `NOT EXISTS` pre-filter: defence-in-depth where the pre-filter is the
   * optimisation and the unique constraint is the guarantee (a tick/worker race
   * or a duplicate job can never create two targets for one message).
   */
  async claimTarget(args: ClaimTargetArgs): Promise<ClaimTargetResult> {
    try {
      await this.prisma.campaignTarget.create({
        data: {
          merchantId: args.merchantId,
          campaignId: args.campaignId,
          messageId: args.messageId,
          customerId: args.customerId,
          // status defaults to 'pending' per schema.
        },
      });
      return 'claimed';
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // messageId @unique collision — another worker (or a duplicate job)
        // already claimed this draft. No-op, not an error.
        return 'already_claimed';
      }
      throw err;
    }
  }

  // ── Gate-chain reads (Epic G batch 8.3) ──────────────────────────────────

  /**
   * Loads the gate context + the replay-guard status for one target, keyed by
   * `messageId` (the `CampaignTarget.messageId @unique`). Returns `null` if the
   * target is gone (GDPR redact cascade-deletes `CampaignTarget`) or its
   * `MerchantSettings` is missing — the worker no-ops on null. Caller MUST be
   * inside `withTenantScope`.
   */
  async loadDispatchContext(args: { messageId: string }): Promise<DispatchContext | null> {
    const target = await this.prisma.campaignTarget.findUnique({
      where: { messageId: args.messageId },
      select: {
        status: true,
        customerId: true,
        // Consent + email is read off the target's customer (the dispatch recipient).
        // Nested relation read — NOT soft-delete-filtered; a redact would have
        // cascade-deleted the target, so reaching here means the customer lives.
        customer: { select: { emailMarketingConsentState: true, email: true } },
        message: {
          select: {
            generatedText: true,
            aiGeneration: { select: { createdAt: true } },
          },
        },
        merchant: {
          select: {
            timezone: true,
            shop: true,
            settings: {
              select: {
                sendTimeStartHour: true,
                sendTimeEndHour: true,
                defaultCooldownHours: true,
                maxDailySendsPerCustomer: true,
                dailySendCap: true,
                monthlySendsCap: true,
              },
            },
          },
        },
      },
    });

    const settings = target?.merchant.settings;
    if (target === null || settings === null || settings === undefined) {
      return null;
    }

    return {
      targetStatus: target.status,
      customerId: target.customerId,
      consentState: target.customer.emailMarketingConsentState,
      generationCreatedAt: target.message.aiGeneration.createdAt,
      timezone: target.merchant.timezone,
      sendTimeStartHour: settings.sendTimeStartHour,
      sendTimeEndHour: settings.sendTimeEndHour,
      defaultCooldownHours: settings.defaultCooldownHours,
      maxDailySendsPerCustomer: settings.maxDailySendsPerCustomer,
      dailySendCap: settings.dailySendCap,
      monthlySendsCap: settings.monthlySendsCap,
      customerEmail: target.customer.email,
      shop: target.merchant.shop,
      generatedText: target.message.generatedText,
    };
  }

  /**
   * Suppression gate read — is there an active suppression for this
   * (merchant, customer, channel)? Reads the `@@unique([merchantId, customerId,
   * channel])` on `Suppression`.
   */
  async isSuppressed(args: {
    merchantId: string;
    customerId: string;
    channel: MessageChannel;
  }): Promise<boolean> {
    const found = await this.prisma.suppression.findUnique({
      where: {
        merchantId_customerId_channel: {
          merchantId: args.merchantId,
          customerId: args.customerId,
          channel: args.channel,
        },
      },
      select: { id: true },
    });
    return found !== null;
  }

  /**
   * Quota gate PRE-FLIGHT read (8.3): today's `MessageQuotaBucket.sentCount` +
   * the running month-sum, both UTC-day-keyed (the `AiSpendBucket` convention).
   * This is a cheap CHECK to avoid deferring a send that would bounce off the
   * cap; the AUTHORITATIVE under-lock increment is 8.4's mark-sent tx (G-Q9), so
   * a small over-admit here is corrected there.
   */
  async getQuotaUsage(args: { merchantId: string; now: Date }): Promise<QuotaUsage> {
    const day = utcMidnight(args.now);
    const monthStart = utcFirstOfMonth(args.now);

    const [todayBucket, monthAgg] = await Promise.all([
      this.prisma.messageQuotaBucket.findUnique({
        where: { merchantId_date: { merchantId: args.merchantId, date: day } },
        select: { sentCount: true },
      }),
      this.prisma.messageQuotaBucket.aggregate({
        _sum: { sentCount: true },
        where: { merchantId: args.merchantId, date: { gte: monthStart } },
      }),
    ]);

    return {
      daySentCount: todayBucket?.sentCount ?? 0,
      monthSentCount: monthAgg._sum.sentCount ?? 0,
    };
  }

  // ── Gate-chain writes (Epic G batch 8.3) ─────────────────────────────────

  /**
   * TERMINAL outcome — sets `CampaignTarget.status` (default `'suppressed'`,
   * `'failed'` for 8.4 non-retryable SES failures) + the forensic
   * `suppressedByGate` reason AND `Message.status` to the matching terminal
   * in ONE transaction (never one without the other). Serves:
   *
   *   - 8.3 gate suppression (reason = the gate name, status = 'suppressed')
   *   - 8.3 arm-2 lifecycle terminals (reason = `'campaign_paused'` /
   *     `'deferred_stale'`, status = 'suppressed')
   *   - 8.4 SES non-retryable failures (reason = the EmailProviderError code,
   *     status = 'failed' — `email_auth` / `email_invalid_request` /
   *     `email_account_suspended`)
   *   - 8.4 SES recipient-suppressed terminal (reason = `'ses_suppressed'`,
   *     status = 'suppressed') — a policy block, not a processing fault,
   *     so it lands on `suppressed` even though the cause is the ESP.
   *
   * `status='failed'` is reserved for processing faults (the worker COULD
   * have sent, but the provider/credentials/payload rejected it); the
   * Message also lands at `'failed'` so a burned draft never looks
   * dispatchable again. `status='suppressed'` is a policy decision (a
   * gate-rule said no, or the recipient is on a suppression list).
   *
   * IN-TX RACE GUARD: the `CampaignTarget` update is guarded on
   * `status IN ('pending', 'deferred', 'sending')` — `sending` added at
   * 8.4 so a non-retryable error caught AFTER the pre-send tx commits
   * can still terminalise the row. If 0 rows touch, another worker
   * already resolved (duplicate-job race) → the `Message` write is
   * SKIPPED and `resolved:false` returned. The two writes can never
   * diverge.
   */
  async resolveTerminal(args: {
    messageId: string;
    reason: string;
    /** Defaults to 'suppressed' (preserves the 8.3 contract). */
    status?: 'suppressed' | 'failed';
  }): Promise<{ resolved: boolean }> {
    const terminalStatus = args.status ?? 'suppressed';
    return this.prisma.$transaction(async (extendedTx) => {
      // Prisma 5 typing gap — runtime extension hooks fire on `extendedTx`;
      // only the static type differs (same cast as the AI worker's tx).
      const tx = extendedTx as unknown as Prisma.TransactionClient;

      const target = await tx.campaignTarget.updateMany({
        where: {
          messageId: args.messageId,
          status: { in: ['pending', 'deferred', 'sending'] },
        },
        data: { status: terminalStatus, suppressedByGate: args.reason },
      });

      if (target.count === 0) {
        // Already terminal (race / replay) — do NOT touch the Message.
        return { resolved: false };
      }

      // The Message advances to the MATCHING terminal. A burned draft must NOT
      // look dispatchable again under any later pickup (the arm-1 pickup keys
      // on `status='draft'`). A `sending` row's Message stays at `draft` until
      // this point — so the guard `status='draft'` is correct in BOTH the 8.3
      // suppression path AND the 8.4 failure path.
      await tx.message.updateMany({
        where: { id: args.messageId, status: 'draft' },
        data: { status: terminalStatus },
      });

      return { resolved: true };
    });
  }

  // ── Send-path writes (Epic G batch 8.4) ──────────────────────────────────

  /**
   * Pre-send tx — flip `CampaignTarget.status: pending → sending` and stamp
   * `sendStartedAt`. ITS OWN COMMITTED WRITE, called BEFORE the external SES
   * call. After it commits, the row is in the tombstone state regardless of
   * what happens next.
   *
   * Compare-and-set on `status='pending'`. Returns:
   *   - `'started'`                    — the CAS succeeded; the worker proceeds to send.
   *   - `'noop_not_pending'`           — the row is no longer pending. The worker
   *                                      bails. The current status helps the
   *                                      caller log the right reason (race vs replay).
   *   - `'noop_target_missing'`        — the row is gone (GDPR redact cascade).
   *
   * Caller MUST be inside `withTenantScope`.
   *
   * Crash semantics walked at 8.4 Phase 1 §2:
   *   - C1 (crash BEFORE this commits): row stays `pending`, next pass re-claims
   *     idempotently and retries cleanly.
   *   - C1' (crash AFTER commit, BEFORE SES dispatch — microsecond window): row
   *     sits at `sending`, NEVER auto-resends. Operator rescue per OPERATIONS.md.
   */
  async startSending(args: {
    messageId: string;
    now: Date;
  }): Promise<
    | { kind: 'started' }
    | { kind: 'noop_not_pending'; currentStatus: CampaignTargetStatus }
    | { kind: 'noop_target_missing' }
  > {
    const updated = await this.prisma.campaignTarget.updateMany({
      where: { messageId: args.messageId, status: 'pending' },
      data: { status: 'sending', sendStartedAt: args.now },
    });
    if (updated.count > 0) return { kind: 'started' };

    // CAS missed — re-read to surface the actual state to the caller.
    const current = await this.prisma.campaignTarget.findUnique({
      where: { messageId: args.messageId },
      select: { status: true },
    });
    if (current === null) return { kind: 'noop_target_missing' };
    return { kind: 'noop_not_pending', currentStatus: current.status };
  }

  /**
   * Retryable-error recovery — flip `CampaignTarget.status: sending → pending`
   * (CAS-guarded). Called by the dispatch worker when SES returns a retryable
   * error (`EmailProviderRateLimitError` / `EmailProviderTransientError`).
   *
   * WHY this exists (the worker-flow load-bearer): the pre-send tx pushed the
   * row to `sending` BEFORE the external call. The replay guard short-circuits
   * `sending` to prevent auto-resend on a CRASH. But on a CLEAN retryable
   * failure, SES TOLD us it did not send — safe to retry. Without this
   * revert, BullMQ's retry would re-enter `processCampaignDispatchJob`, hit
   * the replay guard, and exit as a no-op — converting a transient SES rate
   * limit into a permanently-stuck `sending` row.
   *
   * `sendStartedAt` is also cleared (the next pre-send tx will set it fresh,
   * so the operator-observability `WHERE status='sending' AND sendStartedAt
   * < NOW() - INTERVAL '1 hour'` query stays accurate across reverts).
   *
   * CAS-guarded on `status='sending'`: if some other path beat us to a
   * terminal, the revert is a no-op. A revert from any state other than
   * `sending` is meaningless — only the worker that just attempted a send
   * should call this.
   */
  async revertToPending(args: {
    messageId: string;
  }): Promise<{ reverted: boolean }> {
    const result = await this.prisma.campaignTarget.updateMany({
      where: { messageId: args.messageId, status: 'sending' },
      data: { status: 'pending', sendStartedAt: null },
    });
    return { reverted: result.count > 0 };
  }

  /**
   * Shared completion-tx for a successful SES send (Epic G batch 8.4). Run
   * by the dispatch worker on a SES ACK; ALSO run by 8.5's SNS Delivery
   * handler when reconciling a stuck `sending` row (the auto-recovery path
   * for C2/C3 crashes — the SNS event has all the info the worker would
   * have written). **Single shared method = no drift possible between
   * the two callers.**
   *
   * Atomically (one `prisma.$transaction`):
   *   1. SELECT FOR UPDATE today's MessageQuotaBucket row (UPSERT-if-missing
   *      race-safely; the existing `(merchantId, date)` unique handles the
   *      INSERT race, then a fresh SELECT FOR UPDATE acquires the row lock).
   *   2. Bucket `sentCount += 1`. Authoritative under the row lock.
   *   3. UPDATE CampaignTarget WHERE status='sending' SET status='sent',
   *      sentAt=now. CAS guards against a race-replay; if 0 rows touch the
   *      tx aborts and the bucket increment rolls back (no double-count).
   *   4. UPDATE Message WHERE status='draft' SET status='sent', sentAt=now,
   *      channel='email', provider='amazon-ses', providerMessageId=... Race-
   *      replay guard same as A4's pattern.
   *   5. AuditLog `dispatch.sent` with the providerMessageId in context.
   *      NO recipient address, NO body — PII / customer-facing content
   *      does NOT belong in audit rows.
   *
   * QUOTA SEMANTICS (G-Q9 — locked at Phase 1 §3): the under-lock cap check
   * is BOOKKEEPING, NOT a control flow gate. The pre-flight gate 6 (8.3)
   * defers at-or-above-cap rows; the under-lock increment commits anyway
   * because the SES send already happened (external HTTP is irreversible
   * outside the tx — the doc's earlier "abort + re-queue" wording is
   * incoherent and is parked for the post-8.4 doc-fix). The overshoot is
   * bounded by worker concurrency (currently 1, so 0 in practice; ≤ N at
   * future scale).
   *
   * Returns:
   *   - `{ kind: 'sent' }`                — happy path, tx committed.
   *   - `{ kind: 'noop_already_terminal', currentStatus }` — the row is no
   *     longer in `sending` (race-replay / 8.5 beat us). The tx aborted
   *     before any write; bucket NOT incremented.
   *
   * Caller MUST be inside `withTenantScope`.
   */
  async markSentWithQuota(args: {
    messageId: string;
    merchantId: string;
    shop: string;
    campaignId: string;
    customerId: string;
    providerMessageId: string;
    now: Date;
  }): Promise<
    | { kind: 'sent' }
    | { kind: 'noop_already_terminal'; currentStatus: CampaignTargetStatus }
  > {
    const dayBucketDate = utcMidnight(args.now);
    // The CAS-failed branch needs to signal the caller without inspecting a
    // status field that may have advanced under us; use a sentinel marker
    // thrown out of the tx and caught here. We can't return early from inside
    // `$transaction` once started without rolling back, so this is the
    // simplest CAS-fail signalling that keeps the tx rollback semantics.
    const CAS_MISS_MARKER = '__winback_dispatch_cas_miss__';

    try {
      await this.prisma.$transaction(async (extendedTx) => {
        const tx = extendedTx as unknown as Prisma.TransactionClient;

        // (1) Race-safe upsert + SELECT FOR UPDATE for the day's bucket.
        //
        // CRITICAL: do NOT use `prisma.create() + try/catch P2002`. Postgres
        // 23505 (unique violation) aborts the WHOLE transaction; catching the
        // P2002 in app code leaves the Postgres tx in the `aborted` state, and
        // the subsequent SELECT FOR UPDATE fails with 25P02 (current
        // transaction is aborted). Verified empirically against real PG via
        // the integration suite, 2026-06-28.
        //
        // INSERT … ON CONFLICT DO NOTHING does NOT raise the unique violation
        // at the Postgres layer — the conflict is consumed by the ON CONFLICT
        // clause — so the tx stays clean. We generate the id in JS because the
        // `id String @id @default(cuid())` default is a Prisma client-side
        // generator, NOT a Postgres function — raw SQL has no access to it.
        const bucketId = randomUUID();
        await tx.$executeRaw`
          INSERT INTO "MessageQuotaBucket" ("id", "merchantId", "date", "sentCount", "createdAt", "updatedAt")
          VALUES (${bucketId}, ${args.merchantId}, ${dayBucketDate}, 0, NOW(), NOW())
          ON CONFLICT ("merchantId", "date") DO NOTHING
        `;
        await tx.$queryRaw`
          SELECT "id" FROM "MessageQuotaBucket"
          WHERE "merchantId" = ${args.merchantId} AND "date" = ${dayBucketDate}
          FOR UPDATE
        `;

        // (3) FIRST — CAS the CampaignTarget. If the row is no longer
        // `sending` we abort before the bucket increment commits.
        const target = await tx.campaignTarget.updateMany({
          where: { messageId: args.messageId, status: 'sending' },
          data: { status: 'sent', sentAt: args.now },
        });
        if (target.count === 0) {
          throw new Error(CAS_MISS_MARKER);
        }

        // (4) Message advance (race-replay guard same as A4).
        const message = await tx.message.updateMany({
          where: { id: args.messageId, status: 'draft' },
          data: {
            status: 'sent',
            sentAt: args.now,
            channel: 'email',
            provider: 'amazon-ses',
            providerMessageId: args.providerMessageId,
          },
        });
        if (message.count === 0) {
          // Inconsistent state — the CampaignTarget was at `sending` but the
          // Message is not at `draft`. Roll back to avoid a half-advance.
          throw new Error(CAS_MISS_MARKER);
        }

        // (2) Bucket increment AFTER the CAS guards pass — keeps the count
        // accurate when a CAS-fail rolls back.
        await tx.messageQuotaBucket.updateMany({
          where: { merchantId: args.merchantId, date: dayBucketDate },
          data: { sentCount: { increment: 1 } },
        });

        // (5) AuditLog `dispatch.sent` in the SAME tx (rule #14).
        const auditLogRepo = new AuditLogRepository(this.prisma);
        await auditLogRepo.append(
          {
            merchantId: args.merchantId,
            shop: args.shop,
            actorType: 'system',
            actorId: 'drainer',
            action: AUDIT_ACTIONS.dispatch.sent,
            targetType: 'campaign_target',
            targetId: args.messageId,
            context: {
              campaignId: args.campaignId,
              customerId: args.customerId,
              providerMessageId: args.providerMessageId,
            },
          },
          tx,
        );
      });
    } catch (err) {
      if (err instanceof Error && err.message === CAS_MISS_MARKER) {
        const current = await this.prisma.campaignTarget.findUnique({
          where: { messageId: args.messageId },
          select: { status: true },
        });
        // The status MAY be `sending` still if it was the Message CAS that
        // failed — that's the inconsistent-state branch; surface as terminal
        // for forensics (the caller logs + bails; SNS may still reconcile).
        return {
          kind: 'noop_already_terminal',
          currentStatus: current?.status ?? 'sent',
        };
      }
      throw err;
    }
    return { kind: 'sent' };
  }

  /**
   * TRANSIENT outcome — `CampaignTarget.status = 'deferred'` (Message stays
   * `draft`; a deferred target is waiting, not suppressed). Guarded on
   * `status IN ('pending','deferred')` so it never resurrects a terminal target.
   * Idempotent: re-deferring an already-deferred target is a no-op-equivalent
   * (the defer-age anchor is the immutable `createdAt`, so the re-write doesn't
   * reset the expiry clock).
   */
  async deferTarget(args: { messageId: string }): Promise<{ deferred: boolean }> {
    const result = await this.prisma.campaignTarget.updateMany({
      where: { messageId: args.messageId, status: { in: ['pending', 'deferred'] } },
      data: { status: 'deferred' },
    });
    return { deferred: result.count > 0 };
  }

  /**
   * Dispatch sweep ARM 2 — the deferred-target re-entry set. Returns every
   * `deferred` target for this merchant with its claim time (`createdAt`, the
   * defer-age anchor) + whether its campaign is still active, so the sweep can
   * partition: young + active → re-enqueue (re-gate); stale → expire; paused →
   * resolve. Disjoint from the arm-1 `NOT EXISTS` draft pickup (which can never
   * re-select a claimed target). Caller MUST be inside `withTenantScope`.
   */
  async findDeferredTargets(args: { merchantId: string }): Promise<readonly DeferredTarget[]> {
    const rows = await this.prisma.campaignTarget.findMany({
      where: { merchantId: args.merchantId, status: 'deferred' },
      select: {
        messageId: true,
        campaignId: true,
        customerId: true,
        createdAt: true,
        campaign: { select: { status: true } },
      },
    });

    return rows.map((r) => ({
      messageId: r.messageId,
      campaignId: r.campaignId,
      customerId: r.customerId,
      createdAt: r.createdAt,
      campaignActive: r.campaign.status === 'active',
    }));
  }
}

// ---------------------------------------------------------------------------
// File-private UTC date helpers (MessageQuotaBucket is UTC-day-keyed, the same
// convention as AiSpendBucket).
// ---------------------------------------------------------------------------

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function utcFirstOfMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
