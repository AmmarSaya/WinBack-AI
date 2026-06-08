import { type Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, OUTBOX_EVENTS } from '@winback/contracts';
import { getLogger } from '@winback/logger';

import type { WinbackPrisma } from '../client.js';
import { buildCustomerStateChangedPayload } from '../events/customer-state-changed.js';
import type { AuditLogRepository } from '../repositories/audit-log.repository.js';
import type { CustomerScoreRepository } from '../repositories/customer-score.repository.js';
import { assertScopeMatchesMerchant } from '../tenant-scope.js';
import { UnitOfWork } from '../unit-of-work.js';

import {
  INSUFFICIENT_COHORT_THRESHOLD,
  computeQuintileBoundaries,
  resolveLurker,
  resolveScorableCustomer,
  resolveScorableCustomerWithBoundaries,
  type CustomerStateValue,
  type QuintileBoundaries,
  type ResolvedCustomerScore,
} from './scoring-math.js';

/**
 * Batch size for `bulkRescore` — customers scored per transaction (one
 * `UnitOfWork.run` tx per chunk). 500 balances round-trips against tx
 * duration / lock-hold time. Tunable; see the §Scale notes in `bulkRescore`.
 */
const BULK_RESCORE_BATCH_SIZE = 500;

/**
 * Per-batch tx timeout for `bulkRescore`. 60s per the UnitOfWork "bulk state
 * transition (chunked)" guidance — a 500-customer chunk does ~1.5k queries.
 */
const BULK_RESCORE_TX_TIMEOUT_MS = 60_000;

const log = getLogger('db.customer-score.service');

/**
 * CustomerScoreService — Epic E session 2.
 *
 * Recomputes RFM + state for a single customer, inline in the drainer's
 * Order / Customer upsert handlers.  See EPIC-E-SESSION-2-DESIGN.md for the
 * full contract.  The pure math lives in `./scoring-math.ts`; this file is
 * the DB orchestration that composes:
 *
 *   1. Read this customer (state + shopify createdAt + shopify GID + active
 *      soft-delete state).  Single-customer findUnique under the active
 *      tenant scope; the soft-delete extension auto-filters deleted rows
 *      so we get `null` for already-deleted customers (legitimate race;
 *      handled as a skip below).
 *   2. Read this merchant (shop currency + shop string for the AuditLog).
 *   3. Read the live scorable cohort from `Order` (NOT from CustomerScore —
 *      see §S-4 / `readCohort` docstring; that would be circular).
 *   4. Pick the resolution branch:
 *        - cohort row present → `resolveScorableCustomer` (normal path)
 *        - cohort row absent  → `resolveLurker`           (§S-6 fallback)
 *      Two distinct functions, no fallthrough.  The lurker branch is the
 *      one the user audit flagged as most-likely to hide a missing-branch
 *      bug; keeping it physically separate makes it obvious in code review.
 *   5. Upsert the CustomerScore row (always — refreshes `computedAt` even
 *      when state didn't change).
 *   6. On state change ONLY: update `Customer.state` (always — the band must
 *      be correct), then — GATED on `Merchant.scoringInitializedAt` being
 *      non-null (first-pass suppression, Lock V10 / lock #22 C9) — write the
 *      AuditLog row + the `customer.state_changed` OutboxEvent row. While the
 *      flag is null the band write persists but emission is suppressed (no
 *      install-day winback storm). See ARCHITECTURE.md "Customer State
 *      Single-Owner Policy".
 *
 * All reads and writes share the caller's `tx` argument (TX invariant from
 * session 1).  The service does NOT open its own tenant scope — it
 * composes inside the caller's `withTenantScope` (drainer handlers) or
 * `withSystemScope` (future operator bulk-rescore CLI).
 * `assertScopeMatchesMerchant` at the top fails fast on no-scope misuse.
 */
export class CustomerScoreService {
  constructor(
    private readonly customerScoreRepo: CustomerScoreRepository,
    private readonly auditLogRepo: AuditLogRepository,
  ) {}

  /**
   * Recompute and apply scoring for ONE customer.
   *
   * Reads the entire merchant cohort on every call.  O(N) per customer
   * event.  Scale ceiling ~10k per S-10.  Do not call from backfill per
   * S-9.
   *
   * Idempotent under replay: `upsertScore` is keyed on `customerId`,
   * `Customer.state` update is a no-op when state hasn't changed (the
   * state-change branch short-circuits), AuditLog rows are append-only
   * but the producer side won't append unless `previousState !== newState`.
   *
   * `now` is optional; defaults to `new Date()` at call time.  Tests pass
   * an explicit instant for determinism.
   *
   * Returns a metadata object with the resolved score + state-change
   * flag + cohort size + duration.  Caller (drainer handler) logs the
   * S-10 observability fields.
   *
   * Race handling: if `tx.customer.findUnique` returns null, the customer
   * has been soft-deleted between the order/customer upsert and this
   * recompute call (or the caller passed a bogus id).  Returns
   * `{ skipped: 'customer_not_found', ... }` rather than throwing — we
   * don't want the parent tx to roll back the business write just because
   * the per-customer score couldn't refresh.
   */
  async recompute(args: RecomputeArgs): Promise<RecomputeResult> {
    const startMs = Date.now();
    const { merchantId, customerId, tx } = args;
    const now = args.now ?? new Date();

    assertScopeMatchesMerchant(merchantId);

    // -----------------------------------------------------------------------
    // (1) Read the customer.  Soft-delete extension applies — null result
    // means already-deleted-or-absent (race handling below).
    // -----------------------------------------------------------------------
    const customer = await tx.customer.findUnique({
      where: { id: customerId },
      select: {
        state: true,
        shopifyCustomerId: true,
        shopifyCreatedAt: true,
        createdAt: true,
      },
    });

    if (customer === null) {
      return {
        skipped: 'customer_not_found',
        cohortSize: 0,
        durationMs: Date.now() - startMs,
      };
    }

    // -----------------------------------------------------------------------
    // (2) Read the merchant for currency + shop denormalization.
    // `installedAt` + `shopDetailsFetchedAt` are selected for the
    // un-enriched-currency WARN log below (operator visibility only).
    // -----------------------------------------------------------------------
    const merchant = await tx.merchant.findUnique({
      where: { id: merchantId },
      select: {
        currency: true,
        shop: true,
        installedAt: true,
        shopDetailsFetchedAt: true,
        // First-pass suppression gate (step 6). null → suppress emission.
        scoringInitializedAt: true,
      },
    });

    if (merchant === null) {
      // Stale callsite operating on a deleted merchant — defensive throw,
      // not a skip.  At this point the parent tx has likely written rows
      // referencing the (gone) merchant, which should not have happened.
      throw new Error(
        `CustomerScoreService.recompute: merchant ${merchantId} not found (deleted while parent tx was open?)`,
      );
    }

    // Per §S-11: snapshot currency at compute time.  Fall back to 'USD'
    // when the merchant hasn't been enriched yet.
    //
    // Q-H1 closure: the Merchant.currency enrichment IS implemented
    // (D2 `handleMerchantInstalled` → `enrichInstall` at install time;
    // D3 `runEnrichmentSweep` every 15 min for D2 failures). The 'USD'
    // fallback fires only when scoring runs against a merchant whose
    // enrichment hasn't completed yet — narrow window (seconds for
    // happy-path; up to 10 minutes for D2-failed installs before D3
    // catches up). Beyond 10 minutes the WARN log below means D3 is
    // failing repeatedly + needs operator attention. See
    // POINTS-TO-CONSIDER.md "Q-H1 — un-enriched-currency fallback
    // observability" for the conditional M10 hard-block.
    if (merchant.currency === null) {
      log.warn(
        {
          merchantId,
          shop: merchant.shop,
          installedAt: merchant.installedAt.toISOString(),
          shopDetailsFetchedAt:
            merchant.shopDetailsFetchedAt?.toISOString() ?? null,
          eventTrigger: 'scoring',
          timeSinceInstallMs:
            Date.now() - merchant.installedAt.getTime(),
        },
        'CustomerScoreService: merchant currency not enriched; falling back to USD for CustomerScore.currency snapshot — D3 enrichment-sweep will heal on next tick (>10min installs warrant operator check)',
      );
    }
    const currency = (merchant.currency ?? 'USD').toUpperCase();

    // -----------------------------------------------------------------------
    // (3) Read the live cohort.
    // -----------------------------------------------------------------------
    const cohort = await this.customerScoreRepo.readCohort({ merchantId, now, tx });
    const cohortSize = cohort.length;
    const isInsufficientCohort = cohortSize < INSUFFICIENT_COHORT_THRESHOLD;

    // -----------------------------------------------------------------------
    // (4) Branch on cohort membership.  Two explicit functions —
    //     `resolveScorableCustomer` for the cohort-present path,
    //     `resolveLurker` for the §S-6 account-age fallback.
    // -----------------------------------------------------------------------
    const cohortRow = cohort.find((row) => row.customerId === customerId);

    let resolved: ResolvedCustomerScore;
    let branchTaken: 'scorable' | 'lurker';

    if (cohortRow !== undefined) {
      branchTaken = 'scorable';
      resolved = resolveScorableCustomer({
        row: cohortRow,
        cohort,
        isInsufficientCohort,
      });
    } else {
      branchTaken = 'lurker';
      // §S-6 explicit lurker handling.  shopifyCreatedAt is the canonical
      // signup timestamp; createdAt is the local cuid timestamp fallback
      // for rows ingested before the shopify enrichment landed.
      const referenceCreatedAt = customer.shopifyCreatedAt ?? customer.createdAt;
      resolved = resolveLurker({
        referenceCreatedAt,
        now,
        isInsufficientCohort,
      });
    }

    const previousState = customer.state;
    const newState = resolved.newState;
    const stateChanged = previousState !== newState;

    // -----------------------------------------------------------------------
    // (5) Upsert score (always — refreshes computedAt even on no state change).
    // -----------------------------------------------------------------------
    const upsertResult = await this.customerScoreRepo.upsertScore({
      merchantId,
      customerId,
      rDays: resolved.rDays,
      fCount: resolved.fCount,
      mCents: resolved.mCents,
      currency,
      rQuintile: resolved.rQuintile,
      fQuintile: resolved.fQuintile,
      mQuintile: resolved.mQuintile,
      churnRiskScore: resolved.churnRiskScore,
      computedAt: now,
      tx,
    });

    // -----------------------------------------------------------------------
    // (6) State-change side effects.  Customer.state update +
    //     AuditLog row + OutboxEvent row, all in the same tx.
    // -----------------------------------------------------------------------
    if (stateChanged) {
      // DATA WRITE — UNCONDITIONAL. Customer.state must always reflect the
      // freshly computed band (lock #22 / C9), regardless of first-pass
      // suppression. The CustomerScore upsert in step (5) is likewise
      // unconditional. Only the transition-REACTION side-effects below are
      // gated.
      await tx.customer.update({
        where: { id: customerId },
        data: { state: newState },
      });

      // FIRST-PASS SUPPRESSION GATE (Lock V10 / POST-EPIC-F §1; lock #22 C9).
      //
      // While `Merchant.scoringInitializedAt` is null the merchant's initial
      // scoring pass has NOT completed, so a band assignment here is an
      // initial baseline, NOT a real transition. Suppress BOTH
      // transition-reaction side-effects — the forensic `state_changed`
      // AuditLog and the `customer.state_changed` OutboxEvent that drives a
      // winback send — to prevent the install-day storm. The data above
      // (Customer.state) + the CustomerScore row ARE the record. The
      // bulk-rescore pass (A1b) sets `scoringInitializedAt` in the same tx as
      // its final batch; from scoring pass 2 onward (steady-state,
      // event-driven), `emit` is true and transitions emit normally.
      const emit = merchant.scoringInitializedAt !== null;
      if (emit) {
        await this.auditLogRepo.append(
          {
            merchantId,
            shop: merchant.shop,
            actorType: 'system',
            actorId: 'drainer',
            action: AUDIT_ACTIONS.customer.state_changed,
            targetType: 'customer',
            targetId: customerId,
            context: {
              oldState: previousState,
              newState,
              rDays: resolved.rDays,
              fCount: resolved.fCount,
              // BigInt serialisation per rule #19 — string in JSON.
              mCents: resolved.mCents.toString(),
              rQuintile: resolved.rQuintile,
              fQuintile: resolved.fQuintile,
              mQuintile: resolved.mQuintile,
              churnRiskScore: resolved.churnRiskScore,
              currency,
              cohortSize,
              branch: branchTaken,
            },
          },
          tx,
        );

        const payload = buildCustomerStateChangedPayload({
          merchantId,
          customerId,
          shopifyCustomerId: customer.shopifyCustomerId,
          oldState: previousState,
          newState,
          computedAt: now,
          rfmScore: {
            rDays: resolved.rDays,
            fCount: resolved.fCount,
            mCents: resolved.mCents,
            rQuintile: resolved.rQuintile,
            fQuintile: resolved.fQuintile,
            mQuintile: resolved.mQuintile,
          },
        });

        await tx.outboxEvent.create({
          data: {
            merchantId,
            type: OUTBOX_EVENTS.customer.state_changed,
            payload: payload,
          },
        });
      } else {
        log.debug(
          { merchantId, customerId, previousState, newState },
          'recompute: state change suppressed (first pass — scoringInitializedAt null)',
        );
      }
    }

    return {
      skipped: null,
      customerScoreId: upsertResult.customerScoreId,
      isNewScore: upsertResult.isNewScore,
      rDays: resolved.rDays,
      fCount: resolved.fCount,
      mCents: resolved.mCents,
      rQuintile: resolved.rQuintile,
      fQuintile: resolved.fQuintile,
      mQuintile: resolved.mQuintile,
      churnRiskScore: resolved.churnRiskScore,
      previousState,
      newState,
      stateChanged,
      branchTaken,
      cohortSize,
      durationMs: Date.now() - startMs,
    };
  }

  /**
   * Bulk first-pass scoring for a whole merchant (A1b / POST-EPIC-F §1,
   * Lock V10). The operator runs this ONCE after a merchant's customer
   * backfill, via `pnpm cli:scoring:bulk-rescore --merchant <id>`. It opens
   * the suppression gate per-merchant: writes `CustomerScore` + `Customer.state`
   * for every customer, then sets `Merchant.scoringInitializedAt`.
   *
   * NEVER EMITS (Design B / lock #22 amendment). `bulkRescore` is a batch
   * (re)assigner, not a transition detector — a batch pass has no "before" to
   * transition from, so emitting `customer.state_changed` would claim phantom
   * transitions. It writes NO AuditLog-per-customer and NO OutboxEvent, full
   * stop, regardless of flag state. The install-day winback storm is therefore
   * structurally impossible: no code path makes this method emit. (Catching up
   * genuinely-missed lapses with sends is the job of a separate, rate-limited
   * periodic decay-rescore sweep — never this method.)
   *
   * ALGORITHM (O(1) cohort read, D4):
   *   1. Read merchant once (currency snapshot + shop for the audit).
   *   2. Read the scorable cohort ONCE (`readCohort`) and compute quintile
   *      boundaries ONCE (pure fn of the cohort). Held for the whole pass.
   *   3. Paginate ALL Customer rows (cursor by id, soft-delete-filtered),
   *      `BULK_RESCORE_BATCH_SIZE` per tx. Per customer: in-cohort →
   *      `resolveScorableCustomerWithBoundaries` (reuses the once-computed
   *      boundaries); absent → `resolveLurker` (account-age). Same branch
   *      `recompute` uses — no parallel reimplementation. Write `CustomerScore`
   *      (upsert) + `Customer.state` (only when it changes). No emission.
   *   4. FINAL tx (separate, D-b): EXACTLY two writes — `scoringInitializedAt`
   *      + the single `merchant.scoring_initialized` AuditLog. No customer
   *      writes here, so it can never leave customers unscored with the flag
   *      set.
   *
   * CRASH-SAFETY (satisfies D5's intent via the BackfillRunner pattern):
   * `scoringInitializedAt` is set ONLY when the final tx commits, AFTER every
   * customer write. A process death mid-pass leaves the flag null, so a rerun
   * redoes the whole pass under suppression (`upsertScore` is idempotent on
   * `customerId`; `Customer.state` writes are idempotent; emission is never
   * produced). The flag is never set on a partial pass.
   *
   * SNAPSHOT BOUNDARY: the cohort + boundaries are a point-in-time snapshot
   * captured at pass start (single `now`). This is exact for the intended use
   * — the install-day first pass runs on a STATIC freshly-backfilled base, no
   * live traffic shifting the cohort mid-pass. A `--force` re-baseline on a
   * LIVE merchant has slightly-stale boundaries for any customer who orders
   * mid-pass; that is self-correcting (the next steady-state `recompute` for
   * that customer reads a fresh cohort) and still never a storm (no emission)
   * — a bounded, known effect, not a surprise.
   *
   * Caller MUST already be in `withTenantScope(merchantId)` (same contract as
   * `recompute` — both methods are caller-scoped; `UnitOfWork.run` requires an
   * active tenant scope). Differs from `BackfillRunner.run` (which opens its
   * own scope) because this is a CustomerScoreService method and the service's
   * contract is caller-scoped.
   */
  async bulkRescore(
    prisma: WinbackPrisma,
    args: {
      readonly merchantId: string;
      readonly actorId: string;
      readonly now?: Date;
      readonly batchSize?: number;
    },
  ): Promise<BulkRescoreResult> {
    const startMs = Date.now();
    const { merchantId, actorId } = args;
    const now = args.now ?? new Date();
    const batchSize = args.batchSize ?? BULK_RESCORE_BATCH_SIZE;

    assertScopeMatchesMerchant(merchantId);

    const uow = new UnitOfWork(prisma);

    // (1) Merchant read — currency snapshot (§S-11) + shop for the audit row.
    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { currency: true, shop: true },
    });
    if (merchant === null) {
      throw new Error(`bulkRescore: merchant ${merchantId} not found`);
    }
    const currency = (merchant.currency ?? 'USD').toUpperCase();

    // (2) Cohort read ONCE + boundaries ONCE. The cohort is the scorable set
    // (customers with paid orders in 365d); lurkers are absent and resolved
    // via account-age below.
    const cohort = await uow.run(
      async (ctx) => this.customerScoreRepo.readCohort({ merchantId, now, tx: ctx.db }),
      { timeout: BULK_RESCORE_TX_TIMEOUT_MS },
    );
    const isInsufficientCohort = cohort.length < INSUFFICIENT_COHORT_THRESHOLD;
    const boundaries: QuintileBoundaries | null = isInsufficientCohort
      ? null
      : computeQuintileBoundaries(cohort);
    const cohortMap = new Map(cohort.map((row) => [row.customerId, row]));

    // (3) Paginate every Customer row; score in batches. NO emission.
    let cursor: string | null = null;
    let customersScored = 0;
    let batches = 0;
    let done = false;
    while (!done) {
      const processed = await uow.run(
        async (ctx) => {
          const tx = ctx.db;
          const customers = await tx.customer.findMany({
            where: { merchantId },
            select: { id: true, state: true, shopifyCreatedAt: true, createdAt: true },
            orderBy: { id: 'asc' },
            take: batchSize,
            // Conditional cursor spread — first page has no cursor; `skip: 1`
            // advances past the cursor row itself.
            ...(cursor !== null && { cursor: { id: cursor }, skip: 1 }),
          });

          for (const c of customers) {
            const cohortRow = cohortMap.get(c.id);
            const resolved: ResolvedCustomerScore =
              cohortRow !== undefined
                ? resolveScorableCustomerWithBoundaries({
                    row: cohortRow,
                    boundaries,
                    isInsufficientCohort,
                  })
                : resolveLurker({
                    referenceCreatedAt: c.shopifyCreatedAt ?? c.createdAt,
                    now,
                    isInsufficientCohort,
                  });

            await this.customerScoreRepo.upsertScore({
              merchantId,
              customerId: c.id,
              rDays: resolved.rDays,
              fCount: resolved.fCount,
              mCents: resolved.mCents,
              currency,
              rQuintile: resolved.rQuintile,
              fQuintile: resolved.fQuintile,
              mQuintile: resolved.mQuintile,
              churnRiskScore: resolved.churnRiskScore,
              computedAt: now,
              tx,
            });

            // DATA write only when the band actually changes — keeps the
            // write count down on a re-baseline. NO AuditLog, NO OutboxEvent:
            // bulkRescore never emits (Design B).
            if (c.state !== resolved.newState) {
              await tx.customer.update({
                where: { id: c.id },
                data: { state: resolved.newState },
              });
            }
          }

          return { count: customers.length, lastId: customers.at(-1)?.id ?? null };
        },
        { timeout: BULK_RESCORE_TX_TIMEOUT_MS },
      );

      customersScored += processed.count;
      batches += 1;
      log.debug(
        { merchantId, batch: batches, customersInBatch: processed.count, customersScored },
        'bulkRescore: batch committed',
      );

      if (processed.count < batchSize || processed.lastId === null) {
        done = true;
      } else {
        cursor = processed.lastId;
      }
    }

    // (4) FINAL tx — EXACTLY two writes: flag-flip + the single audit. This is
    // the only place scoringInitializedAt is set, and it commits last (D-b /
    // D5 crash-safety intent). No customer writes here.
    await uow.run(
      async (ctx) => {
        await ctx.db.merchant.update({
          where: { id: merchantId },
          data: { scoringInitializedAt: now },
        });
        await this.auditLogRepo.append(
          {
            merchantId,
            shop: merchant.shop,
            actorType: 'system',
            actorId,
            action: AUDIT_ACTIONS.merchant.scoring_initialized,
            targetType: 'merchant',
            targetId: merchantId,
            context: {
              customersScored,
              batches,
              cohortSize: cohort.length,
              insufficientCohort: isInsufficientCohort,
            },
          },
          ctx.db,
        );
      },
      { timeout: BULK_RESCORE_TX_TIMEOUT_MS },
    );

    const durationMs = Date.now() - startMs;
    log.info(
      { merchantId, customersScored, batches, cohortSize: cohort.length, durationMs },
      'bulkRescore: first scoring pass complete; scoringInitializedAt set (no events emitted)',
    );

    return { customersScored, batches, cohortSize: cohort.length, durationMs };
  }
}

/** Result metadata from a `CustomerScoreService.bulkRescore` pass. */
export interface BulkRescoreResult {
  readonly customersScored: number;
  readonly batches: number;
  readonly cohortSize: number;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RecomputeArgs {
  readonly merchantId: string;
  /** Local Customer.id (cuid). */
  readonly customerId: string;
  readonly tx: Prisma.TransactionClient;
  /** Reference instant for the recompute.  Defaults to `new Date()`. */
  readonly now?: Date;
}

/**
 * Discriminated result.  `skipped: 'customer_not_found'` returns minimal
 * metadata only; the success path returns the full score + state delta.
 */
export type RecomputeResult = RecomputeSkippedResult | RecomputeAppliedResult;

export interface RecomputeSkippedResult {
  readonly skipped: 'customer_not_found';
  readonly cohortSize: number;
  readonly durationMs: number;
}

export interface RecomputeAppliedResult {
  readonly skipped: null;
  readonly customerScoreId: string;
  readonly isNewScore: boolean;
  readonly rDays: number;
  readonly fCount: number;
  readonly mCents: bigint;
  readonly rQuintile: number | null;
  readonly fQuintile: number | null;
  readonly mQuintile: number | null;
  readonly churnRiskScore: number | null;
  readonly previousState: CustomerStateValue;
  readonly newState: CustomerStateValue;
  readonly stateChanged: boolean;
  readonly branchTaken: 'scorable' | 'lurker';
  readonly cohortSize: number;
  readonly durationMs: number;
}
