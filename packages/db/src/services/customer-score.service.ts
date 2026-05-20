import { AUDIT_ACTIONS, OUTBOX_EVENTS } from '@winback/contracts';
import { Prisma } from '@prisma/client';

import { buildCustomerStateChangedPayload } from '../events/customer-state-changed.js';
import type { AuditLogRepository } from '../repositories/audit-log.repository.js';
import type { CustomerScoreRepository } from '../repositories/customer-score.repository.js';
import { assertScopeMatchesMerchant } from '../tenant-scope.js';
import {
  INSUFFICIENT_COHORT_THRESHOLD,
  resolveLurker,
  resolveScorableCustomer,
  type CustomerStateValue,
  type ResolvedCustomerScore,
} from './scoring-math.js';

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
 *   6. On state change ONLY: update `Customer.state`, write the AuditLog
 *      row, write the `customer.state_changed` OutboxEvent row.
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
    // -----------------------------------------------------------------------
    const merchant = await tx.merchant.findUnique({
      where: { id: merchantId },
      select: { currency: true, shop: true },
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
    // when the merchant hasn't been enriched yet (Merchant.currency is
    // nullable until the shop-details fetch lands).
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

    const previousState = customer.state as CustomerStateValue;
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
      await tx.customer.update({
        where: { id: customerId },
        data: { state: newState },
      });

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
          payload: payload as unknown as Prisma.InputJsonValue,
        },
      });
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
