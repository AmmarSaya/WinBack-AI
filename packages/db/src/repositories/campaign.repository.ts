import {
  Prisma,
  type CampaignTargetStatus,
  type EmailMarketingConsentState,
  type MessageChannel,
} from '@prisma/client';

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
        // Consent is read off the target's customer (the dispatch recipient).
        // Nested relation read — NOT soft-delete-filtered; a redact would have
        // cascade-deleted the target, so reaching here means the customer lives.
        customer: { select: { emailMarketingConsentState: true } },
        message: { select: { aiGeneration: { select: { createdAt: true } } } },
        merchant: {
          select: {
            timezone: true,
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
   * TERMINAL outcome — sets `CampaignTarget.status = 'suppressed'` (+ the
   * forensic `suppressedByGate` reason) AND `Message.status = 'suppressed'` in
   * ONE transaction (never one without the other). Serves a gate suppression
   * (reason = the gate name) AND the arm-2 lifecycle terminals (reason =
   * `'campaign_paused'` / `'deferred_stale'`) — all are policy "did not send",
   * so all land on `suppressed` (NOT `failed`, which stays reserved for real
   * processing faults).
   *
   * IN-TX RACE GUARD: the `CampaignTarget` update is guarded on
   * `status IN ('pending','deferred')`; if it touches 0 rows another worker
   * already resolved this target (duplicate-job race) → the `Message` write is
   * SKIPPED and `resolved:false` returned. The two writes can never diverge.
   */
  async resolveTerminal(args: {
    messageId: string;
    reason: string;
  }): Promise<{ resolved: boolean }> {
    return this.prisma.$transaction(async (extendedTx) => {
      // Prisma 5 typing gap — runtime extension hooks fire on `extendedTx`;
      // only the static type differs (same cast as the AI worker's tx).
      const tx = extendedTx as unknown as Prisma.TransactionClient;

      const target = await tx.campaignTarget.updateMany({
        where: { messageId: args.messageId, status: { in: ['pending', 'deferred'] } },
        data: { status: 'suppressed', suppressedByGate: args.reason },
      });

      if (target.count === 0) {
        // Already terminal (race / replay) — do NOT touch the Message.
        return { resolved: false };
      }

      await tx.message.updateMany({
        where: { id: args.messageId, status: 'draft' },
        data: { status: 'suppressed' },
      });

      return { resolved: true };
    });
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
