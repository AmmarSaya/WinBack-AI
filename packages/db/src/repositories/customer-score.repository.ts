import { type CustomerState, Prisma } from '@prisma/client';

import type { CustomerStateValue } from '../events/customer-state-changed.js';
import { assertScopeMatchesMerchant } from '../tenant-scope.js';
import { BaseRepository } from './base.js';

/**
 * CustomerScore repository — typed write chokepoint for the
 * `CustomerScore` table introduced in Epic E session 2.
 *
 * Write surface (session 2 batch 2):
 *   - `readCohort` — aggregates live R/F/M for the merchant's scorable
 *     customer cohort from the `Order` table (NOT from existing
 *     `CustomerScore` rows; that would be circular and stale — see the
 *     method docstring + EPIC-E-SESSION-2-DESIGN.md §S-4).
 *   - `upsertScore` — idempotent per-customer score write.  Single row
 *     per `customerId` via the field-level `@unique` constraint.
 *
 * `readCohort` + `upsertScore` REQUIRE a `tx` argument and the calling
 * site MUST already be in tenant scope (`withTenantScope`).  Reading the
 * cohort and writing the per-customer row must share the same transaction
 * — phantom-read otherwise (TX invariant from session 1).
 *
 * The Epic E UI read methods (`getStateBandCounts`, `listWithCustomer`)
 * are read-only and DO NOT take a `tx` — they execute against
 * `this.prisma` directly, like `CustomerRepository.findByEmail`.  Tenant
 * scope is still asserted at the top of each method (raw findMany /
 * groupBy paths go through the Prisma extension, which would inject /
 * assert merchantId anyway, but the explicit assert fails-fast at the
 * repository boundary if the caller forgot to open a scope).
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
   *   - `customerId` TEXT             → `string`
   *   - `rDays`      INT (cast in SQL) → `number`
   *   - `fCount`     INT (cast in SQL) → `number`
   *   - `mCents`     BIGINT (cast in SQL) → `bigint`
   *
   * Why the explicit `::bigint` cast on the SUM: Postgres widens
   * `SUM(bigint)` to `numeric` to avoid overflow on huge sums. Prisma
   * deserializes `numeric` as `Decimal` (not BigInt), and feeding a
   * `Decimal` to `tx.customerScore.upsert({ mCents })` throws
   * `PrismaClientValidationError: Expected BigInt, provided Float`.
   * The `::bigint` cast keeps the column-native type end-to-end and
   * is safe because no realistic single-customer 365d sum approaches
   * `bigint` max (~9.2 × 10¹⁸ cents = $92 quintillion).
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
             SUM("totalAmountCents")::bigint AS "mCents"
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

  // -------------------------------------------------------------------------
  // Read surface — Epic E UI session.  Read-only loaders.  No `tx` arg.
  // -------------------------------------------------------------------------

  /**
   * Returns a count of customers per `CustomerState` band for the
   * dashboard home cards (`_index.tsx`).  Zero-fills bands with no
   * customers so the UI always renders all 6 cards in a stable order.
   *
   * Soft-deleted customers are excluded automatically by the Prisma
   * soft-delete extension (`Customer` is in `SOFT_DELETE_MODELS` — the
   * extension injects `deletedAt: null` on the read).
   */
  async getStateBandCounts(merchantId: string): Promise<Record<CustomerStateValue, number>> {
    assertScopeMatchesMerchant(merchantId);

    const groups = await this.prisma.customer.groupBy({
      by: ['state'],
      where: { merchantId },
      _count: { _all: true },
    });

    const counts: Record<CustomerStateValue, number> = {
      active: 0,
      warm: 0,
      at_risk: 0,
      dormant: 0,
      lost: 0,
      insufficient_data: 0,
    };
    for (const row of groups) {
      counts[row.state as CustomerStateValue] = row._count._all;
    }
    return counts;
  }

  /**
   * Paginated list of CustomerScore rows joined with their owning
   * Customer, ordered for the `/customers` list route.
   *
   * Sort contract (LOCKED for stable cursor pagination):
   *
   *   1. `churnRiskScore DESC nulls last` — highest churn risk first
   *      (actionable for the merchant), null scores at the bottom
   *      (lurkers + insufficient_data customers).
   *   2. `customer.email ASC` — stable tiebreaker for equal scores
   *      (including the null cluster, which would otherwise be
   *      non-deterministic in Postgres).
   *   3. `id ASC` — final tiebreaker for two customers sharing the
   *      same email (rare; allowed by schema since `Customer.email`
   *      is not `@unique`).  Required for Prisma cursor pagination to
   *      be deterministic.
   *
   * Cursor is the `CustomerScore.id` of the last row of the previous
   * page.  Combined with `skip: 1`, Prisma advances exactly one row past
   * the cursor in the same sort order.
   *
   * Filter: `filterStates` (optional) — if non-empty, restricts to rows
   * whose `Customer.state` is in the set.  Empty / undefined means
   * "no filter".
   *
   * Soft-deleted customers explicitly excluded via
   * `customer.deletedAt: null` — defense in depth, since
   * `CustomerScore → Customer` cascade is on HARD delete, and
   * soft-deleted rows would otherwise still join through.
   *
   * Returns `{ rows, nextCursor }`.  `nextCursor` is non-null iff the
   * next page exists (we fetch `limit + 1` rows and trim).
   */
  async listWithCustomer(args: ListCustomerScoresArgs): Promise<ListCustomerScoresResult> {
    const { merchantId, cursor, limit, filterStates } = args;
    assertScopeMatchesMerchant(merchantId);

    const hasFilter = filterStates !== undefined && filterStates.length > 0;
    const customerWhere: Prisma.CustomerWhereInput = {
      deletedAt: null,
      ...(hasFilter && {
        state: { in: filterStates as readonly CustomerState[] as CustomerState[] },
      }),
    };

    const rows = await this.prisma.customerScore.findMany({
      where: {
        merchantId,
        customer: customerWhere,
      },
      orderBy: [
        { churnRiskScore: { sort: 'desc', nulls: 'last' } },
        { customer: { email: 'asc' } },
        { id: 'asc' },
      ],
      // Conditional spread — Prisma's `cursor` type rejects `undefined`,
      // so we only include the property when paginating past the first
      // page.  `skip: 1` advances past the cursor row itself.
      ...(cursor !== null && { cursor: { id: cursor }, skip: 1 }),
      take: limit + 1,
      // Explicit `select` (not `include`) — the extended Prisma client
      // sometimes loses `include` narrowing in TS inference; an explicit
      // select pins the result row's shape end-to-end.
      select: {
        id: true,
        customerId: true,
        rDays: true,
        fCount: true,
        mCents: true,
        currency: true,
        rQuintile: true,
        fQuintile: true,
        mQuintile: true,
        churnRiskScore: true,
        computedAt: true,
        customer: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            shopifyCustomerId: true,
            state: true,
            lastOrderAt: true,
          },
        },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

    return {
      rows: page.map((row) => ({
        customerScoreId: row.id,
        customerId: row.customerId,
        shopifyCustomerId: row.customer.shopifyCustomerId,
        email: row.customer.email,
        firstName: row.customer.firstName,
        lastName: row.customer.lastName,
        state: row.customer.state as CustomerStateValue,
        lastOrderAt: row.customer.lastOrderAt,
        rDays: row.rDays,
        fCount: row.fCount,
        mCents: row.mCents,
        currency: row.currency,
        rQuintile: row.rQuintile,
        fQuintile: row.fQuintile,
        mQuintile: row.mQuintile,
        churnRiskScore: row.churnRiskScore,
        computedAt: row.computedAt,
      })),
      nextCursor,
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

export interface ListCustomerScoresArgs {
  readonly merchantId: string;
  /** Opaque cursor (= prior page's last row's `CustomerScore.id`).  `null` = first page. */
  readonly cursor: string | null;
  /** Page size.  The repo fetches `limit + 1` internally to detect a next page. */
  readonly limit: number;
  /**
   * Filter by `Customer.state`.  Empty array OR undefined = no filter.
   * Multi-select on the UI is implemented at the route layer; the repo
   * just takes the set.
   */
  readonly filterStates?: readonly CustomerStateValue[];
}

/**
 * One row in the `/customers` list — the CustomerScore fields plus the
 * Customer fields the UI displays.  Flattened from the Prisma join so
 * the route component doesn't need to know the include shape.
 */
export interface ListedCustomerScore {
  readonly customerScoreId: string;
  readonly customerId: string;
  /** Full Shopify GID, e.g. `gid://shopify/Customer/12345`. */
  readonly shopifyCustomerId: string;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly state: CustomerStateValue;
  readonly lastOrderAt: Date | null;
  readonly rDays: number;
  readonly fCount: number;
  readonly mCents: bigint;
  readonly currency: string;
  readonly rQuintile: number | null;
  readonly fQuintile: number | null;
  readonly mQuintile: number | null;
  readonly churnRiskScore: number | null;
  readonly computedAt: Date;
}

export interface ListCustomerScoresResult {
  readonly rows: readonly ListedCustomerScore[];
  /** Non-null iff a next page exists.  Pass back as `cursor` to fetch it. */
  readonly nextCursor: string | null;
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
