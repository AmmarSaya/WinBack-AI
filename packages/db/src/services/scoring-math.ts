// =============================================================================
// Customer scoring math — pure functions.  No I/O, no Prisma, no clocks.
//
// Everything here is unit-tested in `packages/db/tests/scoring-math.test.ts`
// without DB or transaction setup.  The service orchestration lives in
// `customer-score.service.ts` and composes these primitives.
//
// Cohort model (Epic E session 2 — see EPIC-E-SESSION-2-DESIGN.md):
//   - "Scorable cohort" = every customer with ≥1 paid, non-test order in the
//     trailing 365d window.  Lurkers are NOT in the cohort (§S-6).
//   - "Insufficient cohort" = cohort size < INSUFFICIENT_COHORT_THRESHOLD (= 5).
//     When this trips, ALL of a merchant's customers receive
//     `state = 'insufficient_data'` and null quintiles regardless of whether
//     they have paid orders.
//
// Quintile semantics:
//   - Sort the cohort's R / F / M values ascending.
//   - Boundaries = values at the 20 / 40 / 60 / 80 percentile positions
//     (1-indexed rank `Math.ceil(N * p) - 1` into the sorted array).
//   - For F and M (higher = better customer), quintile 5 = top 20%.
//   - For R (lower = more recent = better customer), invert: quintile 5 = bottom 20%.
//   - Ties at boundary values fall into the lower quintile (defensive default).
// =============================================================================

import type { CustomerStateValue } from '../events/customer-state-changed.js';
import type { CustomerScoreCohortRow } from '../repositories/customer-score.repository.js';

export type { CustomerStateValue };

// ---------------------------------------------------------------------------
// Constants — exposed so callers + tests can reference them.
// ---------------------------------------------------------------------------

/** Minimum scorable cohort size to compute meaningful quintiles (§S-4). */
export const INSUFFICIENT_COHORT_THRESHOLD = 5;

/** State boundaries in days since last paid order — strict per §S-5. */
export const STATE_BOUNDARIES_DAYS = {
  active_max: 30,
  warm_max: 90,
  at_risk_max: 180,
  dormant_max: 365,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A resolved per-customer score result, ready for upsert. */
export interface ResolvedCustomerScore {
  readonly rDays: number;
  readonly fCount: number;
  readonly mCents: bigint;
  readonly rQuintile: number | null;
  readonly fQuintile: number | null;
  readonly mQuintile: number | null;
  readonly churnRiskScore: number | null;
  readonly newState: CustomerStateValue;
}

/**
 * Per-dimension quintile boundaries — 4 cutpoints between 5 buckets.
 *
 * Tupled (not `readonly T[]`) so the 4-element invariant is enforced by the
 * type system at every access site. `pickPercentilePositions` constructs the
 * tuple hand-element-by-hand from the literal 4-element `[0.2, 0.4, 0.6, 0.8]`
 * percentile array, so the 4-ness is provable at compile time — the tuple
 * type makes the compiler see what the code already guarantees, not assert
 * an invariant that the runtime might violate.
 */
export interface QuintileBoundaries {
  readonly r: readonly [number, number, number, number]; // 20/40/60/80 percentile cutpoints, ascending in rDays
  readonly f: readonly [number, number, number, number]; // ascending in fCount
  readonly m: readonly [bigint, bigint, bigint, bigint]; // ascending in mCents
}

// ---------------------------------------------------------------------------
// Boundary computation
// ---------------------------------------------------------------------------

/**
 * Compute R / F / M quintile boundaries from the cohort.
 *
 * Caller MUST guarantee `cohort.length >= INSUFFICIENT_COHORT_THRESHOLD`.
 * With a smaller cohort the boundaries collapse / become meaningless; the
 * caller's branch should skip this function entirely and route to the
 * `insufficient_data` path.
 *
 * Each returned boundary array has exactly 4 elements (the 20 / 40 / 60 / 80
 * percentile cutpoints) sorted ascending in that dimension's natural order.
 * The `assignQuintile*` helpers below handle the R-axis inversion.
 */
export function computeQuintileBoundaries(
  cohort: readonly CustomerScoreCohortRow[],
): QuintileBoundaries {
  if (cohort.length < INSUFFICIENT_COHORT_THRESHOLD) {
    throw new Error(
      `computeQuintileBoundaries called with insufficient cohort (size=${String(cohort.length)}, threshold=${String(INSUFFICIENT_COHORT_THRESHOLD)})`,
    );
  }

  const rValues = cohort.map((row) => row.rDays).sort(ascendingNumber);
  const fValues = cohort.map((row) => row.fCount).sort(ascendingNumber);
  const mValues = cohort.map((row) => row.mCents).sort(ascendingBigInt);

  return {
    r: pickPercentilePositions(rValues),
    f: pickPercentilePositions(fValues),
    m: pickPercentilePositions(mValues),
  };
}

// ---------------------------------------------------------------------------
// Quintile assignment — separate helpers per dimension for clarity.
// ---------------------------------------------------------------------------

/**
 * Assign R quintile.  Lower rDays = more recent = better → quintile 5.
 * Boundaries arrive ascending in rDays; inversion is `6 - rank`.
 */
export function assignRQuintile(
  rDays: number,
  boundaries: readonly [number, number, number, number],
): number {
  return invert(rankByAscendingBoundaries(rDays, boundaries));
}

/**
 * Assign F quintile.  Higher fCount = more orders = better → quintile 5.
 */
export function assignFQuintile(
  fCount: number,
  boundaries: readonly [number, number, number, number],
): number {
  return rankByAscendingBoundaries(fCount, boundaries);
}

/**
 * Assign M quintile.  Higher mCents = more spend = better → quintile 5.
 * BigInt arithmetic preserves precision against any realistic order total.
 *
 * The 4-tuple boundary type type-enforces the previously-comment-enforced
 * "caller guarantees exactly 4 boundary values" invariant; indices 0..3
 * are statically known to be defined, so no `!` is needed.
 */
export function assignMQuintile(
  mCents: bigint,
  boundaries: readonly [bigint, bigint, bigint, bigint],
): number {
  let rank = 1;
  if (mCents > boundaries[0]) rank = 2;
  if (mCents > boundaries[1]) rank = 3;
  if (mCents > boundaries[2]) rank = 4;
  if (mCents > boundaries[3]) rank = 5;
  return rank;
}

// ---------------------------------------------------------------------------
// Churn risk score
// ---------------------------------------------------------------------------

/**
 * Compute the churn risk score as the inverse of the sum-of-quintiles.
 *
 *   churnRiskScore = 1 - ((rQ + fQ + mQ) / 15)
 *
 * Range `[0, 1]`.  `(5+5+5)/15 = 1` → score `0` (best customer, lowest risk).
 * `(1+1+1)/15 = 0.2` → score `0.8` (worst customer, highest risk).
 *
 * All three quintiles MUST be defined.  The caller's branch is responsible
 * for short-circuiting when any quintile is null (lurker / insufficient_data).
 */
export function computeChurnRiskScore(
  rQuintile: number,
  fQuintile: number,
  mQuintile: number,
): number {
  return 1 - (rQuintile + fQuintile + mQuintile) / 15;
}

// ---------------------------------------------------------------------------
// State assignment — recency-driven hard boundaries (§S-5)
// ---------------------------------------------------------------------------

/**
 * Map R (days since last paid order, or account-age for lurkers) to a
 * `CustomerState` band.  Boundaries are inclusive on the low side:
 *
 *   rDays ≤ 30  → active
 *   rDays ≤ 90  → warm
 *   rDays ≤ 180 → at_risk
 *   rDays ≤ 365 → dormant
 *   rDays > 365 → lost
 *
 * Edge cases locked in the design doc's edge-case table:
 *   - rDays = 30 → active (≤ wins)
 *   - rDays = 31 → warm
 *   - rDays = 365 → dormant
 *   - rDays = 366 → lost
 */
export function stateFromRecency(rDays: number): Exclude<CustomerStateValue, 'insufficient_data'> {
  if (rDays <= STATE_BOUNDARIES_DAYS.active_max) return 'active';
  if (rDays <= STATE_BOUNDARIES_DAYS.warm_max) return 'warm';
  if (rDays <= STATE_BOUNDARIES_DAYS.at_risk_max) return 'at_risk';
  if (rDays <= STATE_BOUNDARIES_DAYS.dormant_max) return 'dormant';
  return 'lost';
}

// ---------------------------------------------------------------------------
// Lurker fallback — explicit branch per user audit request
// ---------------------------------------------------------------------------

/**
 * Days since the customer's account was created — fallback R for lurkers
 * (§S-6).  A lurker has no paid orders in the trailing-365d window, so the
 * usual `now - lastPaidAt` is undefined.  Account age is the next-best
 * engagement signal: a customer who signed up 200 days ago and never bought
 * is closer to `dormant` than to `active`.
 *
 * `referenceCreatedAt` is `Customer.shopifyCreatedAt ?? Customer.createdAt`
 * — the Shopify-side account creation timestamp where available, falling
 * back to the local cuid creation timestamp.  Both are stored UTC by Prisma.
 *
 * Returns floor of the day difference, never negative.  A customer with a
 * future `createdAt` (clock-skew during ingest) gets `rDays = 0` rather
 * than an invalid negative value.
 */
export function lurkerRDays(referenceCreatedAt: Date, now: Date): number {
  const diffMs = now.getTime() - referenceCreatedAt.getTime();
  if (diffMs <= 0) return 0;
  return Math.floor(diffMs / 86_400_000);
}

// ---------------------------------------------------------------------------
// Top-level resolution — the two explicit branches the caller picks between
// ---------------------------------------------------------------------------

/**
 * Resolve a scorable customer — one whose customerId appears in the cohort
 * aggregation result.  Uses the cohort's R/F/M directly; assigns quintiles
 * against the cohort distribution; derives churn risk + state.
 *
 * When the merchant's cohort is below the §S-4 threshold, raw R/F/M still
 * lands on the row but quintiles + churn are null and state is forced to
 * `insufficient_data` (the cohort is too small to give meaningful ranks).
 */
export function resolveScorableCustomer(args: {
  row: CustomerScoreCohortRow;
  cohort: readonly CustomerScoreCohortRow[];
  isInsufficientCohort: boolean;
}): ResolvedCustomerScore {
  const { row, cohort, isInsufficientCohort } = args;

  // PURE EXTRACTION (A1b / D-a): the boundary computation is the only thing
  // this branch adds over `resolveScorableCustomerWithBoundaries`. Compute
  // the boundaries once (sufficient cohort) or pass null (insufficient), then
  // delegate. `recompute` calls THIS function and is byte-identical in
  // behavior; `bulkRescore` calls the with-boundaries variant directly with a
  // single set of boundaries computed ONCE for the whole pass (D4). One
  // source of resolution truth — no parallel reimplementation.
  const boundaries = isInsufficientCohort ? null : computeQuintileBoundaries(cohort);
  return resolveScorableCustomerWithBoundaries({ row, boundaries, isInsufficientCohort });
}

/**
 * Resolve a scorable customer against PRE-COMPUTED quintile boundaries.
 *
 * Identical resolution to `resolveScorableCustomer`, minus the internal
 * `computeQuintileBoundaries` call — the caller supplies the boundaries (or
 * `null` for an insufficient cohort). This is the seam A1b's `bulkRescore`
 * uses to compute boundaries ONCE for a whole merchant and reuse them across
 * every customer in the pass, instead of recomputing per customer.
 *
 * `boundaries === null` is equivalent to `isInsufficientCohort === true`:
 * both route to the `insufficient_data` path (raw R/F/M, null quintiles).
 * The two are passed together by every caller; the explicit `|| null` guard
 * is belt-and-suspenders against a caller that sets one but not the other.
 */
export function resolveScorableCustomerWithBoundaries(args: {
  row: CustomerScoreCohortRow;
  boundaries: QuintileBoundaries | null;
  isInsufficientCohort: boolean;
}): ResolvedCustomerScore {
  const { row, boundaries, isInsufficientCohort } = args;

  if (isInsufficientCohort || boundaries === null) {
    return {
      rDays: row.rDays,
      fCount: row.fCount,
      mCents: row.mCents,
      rQuintile: null,
      fQuintile: null,
      mQuintile: null,
      churnRiskScore: null,
      newState: 'insufficient_data',
    };
  }

  const rQuintile = assignRQuintile(row.rDays, boundaries.r);
  const fQuintile = assignFQuintile(row.fCount, boundaries.f);
  const mQuintile = assignMQuintile(row.mCents, boundaries.m);
  const churnRiskScore = computeChurnRiskScore(rQuintile, fQuintile, mQuintile);

  return {
    rDays: row.rDays,
    fCount: row.fCount,
    mCents: row.mCents,
    rQuintile,
    fQuintile,
    mQuintile,
    churnRiskScore,
    newState: stateFromRecency(row.rDays),
  };
}

/**
 * Resolve a lurker — a customer with NO paid, in-window order, so they did
 * NOT appear in the cohort aggregation result.  Per §S-6:
 *   - rDays = account age in days (lurkerRDays helper)
 *   - fCount = 0
 *   - mCents = 0n
 *   - quintiles = null (they aren't part of the scoring distribution)
 *   - churn risk = null
 *   - state:
 *       - insufficient cohort → `insufficient_data`
 *       - normal cohort       → `stateFromRecency(account-age rDays)`
 *
 * EXPLICIT branch — user audit flag from batch-3 kickoff.  This is the path
 * most likely to hide a missing-branch bug; keeping it in its own function
 * means a reader can audit it without untangling the scorable path.
 */
export function resolveLurker(args: {
  referenceCreatedAt: Date;
  now: Date;
  isInsufficientCohort: boolean;
}): ResolvedCustomerScore {
  const { referenceCreatedAt, now, isInsufficientCohort } = args;
  const rDays = lurkerRDays(referenceCreatedAt, now);

  return {
    rDays,
    fCount: 0,
    mCents: 0n,
    rQuintile: null,
    fQuintile: null,
    mQuintile: null,
    churnRiskScore: null,
    newState: isInsufficientCohort ? 'insufficient_data' : stateFromRecency(rDays),
  };
}

// ---------------------------------------------------------------------------
// File-private helpers
// ---------------------------------------------------------------------------

function ascendingNumber(a: number, b: number): number {
  return a - b;
}

function ascendingBigInt(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Returns the values at the 20 / 40 / 60 / 80 percentile positions of a
 * sorted-ascending array as a 4-tuple.  Uses 1-indexed-rank semantics:
 * `Math.ceil(N * p) - 1` is the array index of the value at the `p`th
 * percentile.  Both ends are clamped to valid array indices for tiny
 * cohorts (handles edge cases at the threshold of 5 — e.g. a 5-element
 * cohort gets boundaries at indices 0, 1, 2, 3).
 *
 * Returns a `readonly [T, T, T, T]` tuple — hand-constructed element-by-
 * element from a literal 4-position percentile sequence so the 4-ness
 * propagates through the type system to every downstream access site
 * (assignMQuintile / rankByAscendingBoundaries). A `.map()` over the
 * literal 4-array would compile-erase to `T[]` and force `!` at every
 * index access; the explicit 4-tuple construction makes the invariant
 * statically provable.
 */
function pickPercentilePositions<T>(
  sortedAscending: readonly T[],
): readonly [T, T, T, T] {
  const N = sortedAscending.length;
  // Caller guarantees N >= INSUFFICIENT_COHORT_THRESHOLD (= 5), so each
  // clamped index is in-range and the value is defined.  `as T` asserts
  // that against noUncheckedIndexedAccess.
  const at = (p: number): T => {
    const idx = Math.max(0, Math.min(N - 1, Math.ceil(N * p) - 1));
    return sortedAscending[idx] as T;
  };
  return [at(0.2), at(0.4), at(0.6), at(0.8)] as const;
}

/**
 * Linear scan against 4 ascending boundaries.
 * `value <= boundaries[0]` → rank 1; `value > boundaries[3]` → rank 5.
 * Ties at a boundary fall INTO the lower quintile (defensive default).
 * 4-tuple parameter type enforces the 4-element invariant at compile time.
 */
function rankByAscendingBoundaries(
  value: number,
  boundaries: readonly [number, number, number, number],
): number {
  let rank = 1;
  if (value > boundaries[0]) rank = 2;
  if (value > boundaries[1]) rank = 3;
  if (value > boundaries[2]) rank = 4;
  if (value > boundaries[3]) rank = 5;
  return rank;
}

/** Invert a quintile rank: 1↔5, 2↔4, 3↔3.  Used for R-axis (lower=better). */
function invert(rank: number): number {
  return 6 - rank;
}
