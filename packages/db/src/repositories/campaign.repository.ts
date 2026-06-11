import { Prisma } from '@prisma/client';

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
}
