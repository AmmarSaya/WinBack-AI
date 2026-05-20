import { Prisma } from '@prisma/client';

import { assertScopeMatchesMerchant } from '../tenant-scope.js';
import { BaseRepository } from './base.js';

/**
 * CustomerScore repository — typed write chokepoint for the
 * `CustomerScore` table introduced in Epic E session 2.
 *
 * Exposes two methods:
 *   - `readCohort` — aggregates live R/F/M for the merchant's scorable
 *     customer cohort from the `Order` table (NOT from existing
 *     `CustomerScore` rows; that would be circular and stale — see the
 *     method docstring + EPIC-E-SESSION-2-DESIGN.md §S-4).
 *   - `upsertScore` — idempotent per-customer score write.  Single row
 *     per `customerId` via the field-level `@unique` constraint.
 *
 * Both methods REQUIRE a `tx` argument and the calling site MUST already
 * be in tenant scope (`withTenantScope`).  Reading the cohort and writing
 * the per-customer row must share the same transaction — phantom-read
 * otherwise (TX invariant from session 1).
 *
 * Extends `BaseRepository` because `readCohort` uses raw SQL (Prisma's
 * `groupBy` API cannot project a `COALESCE` inside the grouping
 * expression cleanly).  Per `BaseRepository`'s class doc, extending it is
 * itself the signal to reviewers that the file contains raw SQL.  The
 * inline tenant-scope assertion in `readCohort` mirrors the
 * `queryRawScoped` helper — we cannot use the helper itself because the
 * helper binds to `this.prisma`, not the caller's `tx`.
 */
export class CustomerScoreRepository extends BaseRepository {
  /**
   * Live R/F/M aggregates for the merchant's scorable cohort.
   *
   * IMPORTANT — cohort source is the `Order` table, NOT existing
   * `CustomerScore` rows.  Reading CustomerScore would be circular:
   * each customer's quintile depends on the cohort distribution, the
   * cohort distribution comes from the stored scores, and the stored
   * scores come from quintiles.  Stale-fed-stale.  Live aggregation
   * against `Order` is the only correct source.
   *
   * Returns at most one row per customer; only customers with ≥1 paid,
   * non-test order whose `placedAt >= now - 365d` appear.  Lurkers (no
   * paid orders in window) are absent — the caller handles them via
   * the §S-6 account-age fallback.
   *
   * The `now` parameter is the recompute-pass-wide reference instant
   * (captured ONCE in the service per §S-2).  Passing it from the
   * caller — instead of letting SQL `now()` resolve at execution time
   * — ensures every customer in the cohort sees the same `now` for the
   * quintile math, and makes the method deterministic under unit test.
   *
   * Result row types:
   *   - `customerId` TEXT  → `string`
   *   - `rDays`      INT   → `number`
   *   - `fCount`     INT   → `number`
   *   - `mCents`     BIGINT → `bigint`  (Prisma 5 maps BIGINT to BigInt)
   *
   * No `deletedAt` predicate: `Order` is immutable in this schema
   * (cancel / refund are status changes, not soft deletes) — see
   * schema.prisma header §SOFT-DELETE.
   */
  async readCohort(args: {
    merchantId: string;
    now: Date;
    tx: Prisma.TransactionClient;
  }): Promise<readonly CustomerScoreCohortRow[]> {
    const { merchantId, now, tx } = args;
    assertScopeMatchesMerchant(merchantId);

    const windowStart = new Date(now.getTime() - WINDOW_MS);

    return tx.$queryRaw<CustomerScoreCohortRow[]>(Prisma.sql`
      SELECT "customerId",
             FLOOR(EXTRACT(EPOCH FROM (${now}::timestamptz - MAX(COALESCE("shopifyProcessedAt", "placedAt")))) / 86400)::int AS "rDays",
             COUNT(*)::int AS "fCount",
             SUM("totalAmountCents") AS "mCents"
      FROM "Order"
      WHERE "merchantId" = ${merchantId}
        AND "financialStatus" = 'paid'
        AND "isTest" = false
        AND "placedAt" >= ${windowStart}::timestamptz
        AND "customerId" IS NOT NULL
      GROUP BY "customerId"
    `);
  }

  /**
   * Idempotent upsert of the per-customer score row.  Keyed on
   * `customerId` (field-level `@unique` — cuid is globally unique).
   *
   * `merchantId` is denormalised on the row + FK-validated against
   * `Merchant`; the active tenant scope must match (assertion below).
   *
   * Returns the local cuid + a flag indicating whether the row was new.
   * The flag is derived from a pre-write `findUnique` inside the same
   * `tx` argument — same TX-invariant pattern as
   * `OrderRepository.upsertFromWebhook`.
   *
   * Quintile + churn fields are nullable: lurkers and members of an
   * `insufficient_data` cohort pass null per §S-4 / §S-6.  Raw R/F/M
   * fields are always populated.
   */
  async upsertScore(args: UpsertCustomerScoreArgs): Promise<UpsertCustomerScoreResult> {
    const {
      merchantId,
      customerId,
      rDays,
      fCount,
      mCents,
      currency,
      rQuintile,
      fQuintile,
      mQuintile,
      churnRiskScore,
      computedAt,
      tx,
    } = args;
    assertScopeMatchesMerchant(merchantId);

    const existing = await tx.customerScore.findUnique({
      where: { customerId },
      select: { id: true },
    });

    const sharedFields = {
      rDays,
      fCount,
      mCents,
      currency,
      rQuintile,
      fQuintile,
      mQuintile,
      churnRiskScore,
      computedAt,
    };

    const upserted = await tx.customerScore.upsert({
      where: { customerId },
      create: {
        merchantId,
        customerId,
        ...sharedFields,
      },
      update: sharedFields,
      select: { id: true },
    });

    return {
      customerScoreId: upserted.id,
      isNewScore: existing === null,
    };
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One row of the cohort aggregation — represents a single customer's
 * live R/F/M values for the trailing-365d window.  Used by the scoring
 * service to compute quintile boundaries across the cohort.
 */
export interface CustomerScoreCohortRow {
  readonly customerId: string;
  readonly rDays: number;
  readonly fCount: number;
  readonly mCents: bigint;
}

export interface UpsertCustomerScoreArgs {
  readonly merchantId: string;
  /** Local Customer.id (cuid). */
  readonly customerId: string;
  readonly rDays: number;
  readonly fCount: number;
  readonly mCents: bigint;
  /** Shop currency snapshot at compute time (§S-11). */
  readonly currency: string;
  readonly rQuintile: number | null;
  readonly fQuintile: number | null;
  readonly mQuintile: number | null;
  readonly churnRiskScore: number | null;
  readonly computedAt: Date;
  readonly tx: Prisma.TransactionClient;
}

export interface UpsertCustomerScoreResult {
  readonly customerScoreId: string;
  /** `true` when no existing row matched `customerId`; `false` on update. */
  readonly isNewScore: boolean;
}

// ---------------------------------------------------------------------------
// File-private constants
// ---------------------------------------------------------------------------

/** 365 days in milliseconds — the F/M trailing window per §S-3. */
const WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
