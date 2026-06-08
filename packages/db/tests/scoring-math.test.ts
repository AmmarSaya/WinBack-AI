import { describe, expect, it } from 'vitest';

import type { CustomerScoreCohortRow } from '../src/repositories/customer-score.repository.js';
import {
  INSUFFICIENT_COHORT_THRESHOLD,
  STATE_BOUNDARIES_DAYS,
  assignFQuintile,
  assignMQuintile,
  assignRQuintile,
  computeChurnRiskScore,
  computeQuintileBoundaries,
  lurkerRDays,
  resolveLurker,
  resolveScorableCustomer,
  stateFromRecency,
} from '../src/services/scoring-math.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function row(customerId: string, rDays: number, fCount: number, mCents: bigint): CustomerScoreCohortRow {
  return { customerId, rDays, fCount, mCents };
}

/** A 5-element cohort spanning a wide range so each quintile gets one customer. */
const COHORT_5: readonly CustomerScoreCohortRow[] = [
  row('c1', 5, 10, 100_000n), // most-recent, highest F, highest M
  row('c2', 20, 7, 50_000n),
  row('c3', 60, 4, 20_000n),
  row('c4', 200, 2, 5_000n),
  row('c5', 400, 1, 1_000n), // least-recent, lowest F, lowest M
];

// ---------------------------------------------------------------------------
// stateFromRecency — boundary values
// ---------------------------------------------------------------------------

describe('stateFromRecency', () => {
  it.each([
    [0, 'active'],
    [30, 'active'],
    [31, 'warm'],
    [90, 'warm'],
    [91, 'at_risk'],
    [180, 'at_risk'],
    [181, 'dormant'],
    [365, 'dormant'],
    [366, 'lost'],
    [1000, 'lost'],
  ])('rDays=%i → %s', (rDays, expected) => {
    expect(stateFromRecency(rDays)).toBe(expected);
  });

  it('STATE_BOUNDARIES_DAYS constants match documented values (§S-5)', () => {
    expect(STATE_BOUNDARIES_DAYS.active_max).toBe(30);
    expect(STATE_BOUNDARIES_DAYS.warm_max).toBe(90);
    expect(STATE_BOUNDARIES_DAYS.at_risk_max).toBe(180);
    expect(STATE_BOUNDARIES_DAYS.dormant_max).toBe(365);
  });
});

// ---------------------------------------------------------------------------
// lurkerRDays
// ---------------------------------------------------------------------------

describe('lurkerRDays', () => {
  const NOW = new Date('2026-05-20T12:00:00.000Z');

  it('returns floor day diff', () => {
    const created = new Date('2026-04-20T12:00:00.000Z'); // 30 days earlier
    expect(lurkerRDays(created, NOW)).toBe(30);
  });

  it('partial-day diff floors down', () => {
    const created = new Date('2026-05-20T00:00:00.000Z'); // 12 hours earlier
    expect(lurkerRDays(created, NOW)).toBe(0);
  });

  it('one full day + 23h = 1 day (floor)', () => {
    const created = new Date('2026-05-18T13:00:00.000Z'); // 1d 23h earlier
    expect(lurkerRDays(created, NOW)).toBe(1);
  });

  it('createdAt in the future (clock skew) → 0', () => {
    const created = new Date('2026-06-01T00:00:00.000Z');
    expect(lurkerRDays(created, NOW)).toBe(0);
  });

  it('exact-same instant → 0', () => {
    expect(lurkerRDays(NOW, NOW)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeQuintileBoundaries
// ---------------------------------------------------------------------------

describe('computeQuintileBoundaries', () => {
  it('5-element cohort → 4 boundaries at indices 0, 1, 2, 3', () => {
    // Cohort sorted ascending in R: [5, 20, 60, 200, 400]
    // Boundaries at ceil(5 * {.2, .4, .6, .8}) - 1 = [0, 1, 2, 3] → [5, 20, 60, 200]
    const { r } = computeQuintileBoundaries(COHORT_5);
    expect([...r]).toEqual([5, 20, 60, 200]);
  });

  it('5-element cohort F-axis boundaries (ascending in F)', () => {
    // Cohort sorted ascending in F: [1, 2, 4, 7, 10]
    const { f } = computeQuintileBoundaries(COHORT_5);
    expect([...f]).toEqual([1, 2, 4, 7]);
  });

  it('5-element cohort M-axis boundaries (BigInt sort)', () => {
    // Cohort sorted ascending in M: [1k, 5k, 20k, 50k, 100k]
    const { m } = computeQuintileBoundaries(COHORT_5);
    expect([...m]).toEqual([1_000n, 5_000n, 20_000n, 50_000n]);
  });

  it('10-element cohort → boundaries at indices 1, 3, 5, 7', () => {
    const cohort = Array.from({ length: 10 }, (_, i) =>
      row(`c${String(i)}`, i * 10, i, BigInt(i) * 100n),
    );
    // ceil(10 * .2)-1 = 1; ceil(10*.4)-1 = 3; ceil(10*.6)-1 = 5; ceil(10*.8)-1 = 7
    const { r } = computeQuintileBoundaries(cohort);
    expect([...r]).toEqual([10, 30, 50, 70]);
  });

  it('throws when cohort < INSUFFICIENT_COHORT_THRESHOLD', () => {
    const small = COHORT_5.slice(0, 4);
    expect(() => computeQuintileBoundaries(small)).toThrow(/insufficient cohort/i);
  });

  it('threshold constant is 5 (locked at §S-4)', () => {
    expect(INSUFFICIENT_COHORT_THRESHOLD).toBe(5);
  });

  it('handles BigInt > Number.MAX_SAFE_INTEGER without precision loss', () => {
    const big = 9_999_999_999_999_999n; // exceeds 2^53
    const cohort = COHORT_5.map((r) =>
      r.customerId === 'c1' ? { ...r, mCents: big } : r,
    );
    const { m } = computeQuintileBoundaries(cohort);
    // The big number should be the top boundary value position after sort.
    // After sort, values are [1k, 5k, 20k, 50k, big]; boundaries at [0,1,2,3] = [1k, 5k, 20k, 50k]
    expect([...m]).toEqual([1_000n, 5_000n, 20_000n, 50_000n]);
  });
});

// ---------------------------------------------------------------------------
// assignRQuintile — inversion: lower R = higher quintile (better)
// ---------------------------------------------------------------------------

describe('assignRQuintile', () => {
  // Boundaries ascending in rDays: [5, 20, 60, 200]
  // Customer c1 (rDays=5) is MOST recent → quintile 5
  // Customer c5 (rDays=400) is LEAST recent → quintile 1
  // `as const` matches assignRQuintile's `readonly [number, number, number, number]` tuple parameter.
  const boundaries = [5, 20, 60, 200] as const;

  it.each([
    [4, 5], // less than all boundaries → ascending rank 1, inverted to 5 (best)
    [5, 5], // tied with boundary[0] → ascending rank 1 (ties stay low) → inverted 5
    [10, 4], // > b0 ≤ b1 → ascending 2 → inverted 4
    [20, 4],
    [50, 3], // > b1 ≤ b2 → ascending 3 → inverted 3
    [60, 3],
    [100, 2], // > b2 ≤ b3 → ascending 4 → inverted 2
    [200, 2],
    [201, 1], // > b3 → ascending 5 → inverted 1 (worst)
    [1000, 1],
  ])('rDays=%i → quintile %i', (rDays, expected) => {
    expect(assignRQuintile(rDays, boundaries)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// assignFQuintile — non-inverted: higher F = higher quintile
// ---------------------------------------------------------------------------

describe('assignFQuintile', () => {
  const boundaries = [1, 2, 4, 7] as const;

  it.each([
    [0, 1],
    [1, 1], // tied with b0 → rank 1
    [2, 2],
    [3, 3],
    [4, 3],
    [5, 4],
    [7, 4],
    [8, 5],
    [100, 5],
  ])('fCount=%i → quintile %i', (fCount, expected) => {
    expect(assignFQuintile(fCount, boundaries)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// assignMQuintile — non-inverted, BigInt
// ---------------------------------------------------------------------------

describe('assignMQuintile', () => {
  const boundaries = [1_000n, 5_000n, 20_000n, 50_000n] as const;

  it.each<[bigint, number]>([
    [0n, 1],
    [1_000n, 1],
    [1_500n, 2],
    [5_000n, 2],
    [10_000n, 3],
    [20_000n, 3],
    [30_000n, 4],
    [50_000n, 4],
    [60_000n, 5],
    [9_999_999_999_999_999n, 5],
  ])('mCents=%s → quintile %i', (mCents, expected) => {
    expect(assignMQuintile(mCents, boundaries)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// computeChurnRiskScore
// ---------------------------------------------------------------------------

describe('computeChurnRiskScore', () => {
  it('5,5,5 → 0 (best customer, lowest churn risk)', () => {
    expect(computeChurnRiskScore(5, 5, 5)).toBe(0);
  });

  it('1,1,1 → 0.8 (worst customer, highest churn risk)', () => {
    expect(computeChurnRiskScore(1, 1, 1)).toBeCloseTo(0.8);
  });

  it('3,3,3 → 0.4 (midpoint)', () => {
    expect(computeChurnRiskScore(3, 3, 3)).toBeCloseTo(0.4);
  });

  it('5,1,1 → 0.5333… (asymmetric R win)', () => {
    expect(computeChurnRiskScore(5, 1, 1)).toBeCloseTo((1 - 7 / 15), 10);
  });
});

// ---------------------------------------------------------------------------
// resolveScorableCustomer — explicit branches
// ---------------------------------------------------------------------------

describe('resolveScorableCustomer', () => {
  it('normal cohort: returns quintiles + churn risk + state from R', () => {
    // c3 in COHORT_5: rDays=60, fCount=4, mCents=20k
    const target = COHORT_5[2]!;
    const result = resolveScorableCustomer({
      row: target,
      cohort: COHORT_5,
      isInsufficientCohort: false,
    });
    expect(result.rDays).toBe(60);
    expect(result.fCount).toBe(4);
    expect(result.mCents).toBe(20_000n);
    expect(result.rQuintile).toBe(3); // 60 ties with b2=60 → ascending 3 → inverted 3
    expect(result.fQuintile).toBe(3); // 4 ties with b2=4 → 3
    expect(result.mQuintile).toBe(3); // 20k ties with b2=20k → 3
    expect(result.churnRiskScore).toBeCloseTo(1 - 9 / 15);
    expect(result.newState).toBe('warm'); // 60 in (30, 90]
  });

  it('insufficient cohort: raw values pass through, quintiles null, state=insufficient_data', () => {
    const target = COHORT_5[0]!;
    const result = resolveScorableCustomer({
      row: target,
      cohort: COHORT_5.slice(0, 4), // 4 customers — below threshold
      isInsufficientCohort: true,
    });
    expect(result.rDays).toBe(5);
    expect(result.fCount).toBe(10);
    expect(result.mCents).toBe(100_000n);
    expect(result.rQuintile).toBeNull();
    expect(result.fQuintile).toBeNull();
    expect(result.mQuintile).toBeNull();
    expect(result.churnRiskScore).toBeNull();
    expect(result.newState).toBe('insufficient_data');
  });

  it('top of the cohort (c1) → quintile 5 R, F, M; active state', () => {
    const target = COHORT_5[0]!;
    const result = resolveScorableCustomer({
      row: target,
      cohort: COHORT_5,
      isInsufficientCohort: false,
    });
    expect(result.rQuintile).toBe(5);
    expect(result.fQuintile).toBe(5);
    expect(result.mQuintile).toBe(5);
    expect(result.churnRiskScore).toBe(0);
    expect(result.newState).toBe('active');
  });

  it('bottom of the cohort (c5) → quintile 1 R, F, M; lost state', () => {
    const target = COHORT_5[4]!;
    const result = resolveScorableCustomer({
      row: target,
      cohort: COHORT_5,
      isInsufficientCohort: false,
    });
    expect(result.rQuintile).toBe(1);
    expect(result.fQuintile).toBe(1);
    expect(result.mQuintile).toBe(1);
    expect(result.churnRiskScore).toBeCloseTo(0.8);
    expect(result.newState).toBe('lost'); // 400 > 365
  });
});

// ---------------------------------------------------------------------------
// resolveLurker — explicit branch per user audit flag
// ---------------------------------------------------------------------------

describe('resolveLurker', () => {
  const NOW = new Date('2026-05-20T12:00:00.000Z');

  it('insufficient cohort: state=insufficient_data even if account is recent', () => {
    const created = new Date('2026-05-19T12:00:00.000Z'); // 1 day ago
    const result = resolveLurker({
      referenceCreatedAt: created,
      now: NOW,
      isInsufficientCohort: true,
    });
    expect(result.newState).toBe('insufficient_data');
    expect(result.rDays).toBe(1);
    expect(result.fCount).toBe(0);
    expect(result.mCents).toBe(0n);
    expect(result.rQuintile).toBeNull();
    expect(result.fQuintile).toBeNull();
    expect(result.mQuintile).toBeNull();
    expect(result.churnRiskScore).toBeNull();
  });

  it('normal cohort + lurker, 200d account age → dormant per §S-5', () => {
    const created = new Date(NOW.getTime() - 200 * 86_400_000);
    const result = resolveLurker({
      referenceCreatedAt: created,
      now: NOW,
      isInsufficientCohort: false,
    });
    expect(result.newState).toBe('dormant'); // 200 in (180, 365]
    expect(result.rDays).toBe(200);
    expect(result.fCount).toBe(0);
    expect(result.mCents).toBe(0n);
    expect(result.rQuintile).toBeNull();
    expect(result.fQuintile).toBeNull();
    expect(result.mQuintile).toBeNull();
    expect(result.churnRiskScore).toBeNull();
  });

  it('normal cohort + brand-new lurker (0 days) → active state, still no quintiles', () => {
    const result = resolveLurker({
      referenceCreatedAt: NOW,
      now: NOW,
      isInsufficientCohort: false,
    });
    expect(result.newState).toBe('active'); // rDays=0, in [0, 30]
    expect(result.rQuintile).toBeNull(); // explicit: never a quintile for a lurker
  });

  it('lurker with very old account (500d) → lost state', () => {
    const created = new Date(NOW.getTime() - 500 * 86_400_000);
    const result = resolveLurker({
      referenceCreatedAt: created,
      now: NOW,
      isInsufficientCohort: false,
    });
    expect(result.newState).toBe('lost');
    expect(result.rDays).toBe(500);
  });
});
