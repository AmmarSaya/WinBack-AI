import type { Prisma } from '@prisma/client';

import type { WinbackPrisma } from '../client.js';

/**
 * Repository for the `AiSpendBucket` table — the typed write chokepoint
 * for the daily-granularity LLM-spend ledger used by Epic F's
 * per-merchant monthly cap (§F-6).
 *
 * Three methods:
 *
 *   - `getOrCreateForDay` — idempotent. Returns the bucket-row id for
 *                            (merchantId, date-truncated-to-UTC-midnight).
 *                            Concurrent first-callers all see the same
 *                            row via the @@unique synchronization
 *                            point. Useful for operator queries + the
 *                            M10 stale-pending sweep cron (per
 *                            §F-6 surface table).
 *
 *   - `incrementSpend`    — Atomic increment after a successful LLM
 *                            call. Adds `deltaMicrocents` to
 *                            `spentMicrocents` and 1 to
 *                            `generationCount`. Uses Prisma's `upsert`
 *                            with `{ increment }` operators — Postgres
 *                            INSERT ... ON CONFLICT DO UPDATE acquires
 *                            the row-level lock on the
 *                            @@unique([merchantId, date]) synchronization
 *                            point during the update path, which is the
 *                            same lock SELECT FOR UPDATE would acquire
 *                            (just folded into one round-trip instead
 *                            of three). Concurrent jobs for the same
 *                            merchant on the same day serialise
 *                            correctly via the unique-index lock.
 *
 *                            Decision history: the original §F-6 design
 *                            wording said "SELECT FOR UPDATE semantics"
 *                            and the session bootstrap explicitly
 *                            prescribed raw SQL with `assertScopeMatches
 *                            Merchant`. Phase 1 audit (2026-05-24)
 *                            corrected this — Postgres's ON CONFLICT DO
 *                            UPDATE path provides the same atomicity
 *                            guarantee with 1/3 the round-trip latency
 *                            and no raw-SQL footgun. The Prisma
 *                            extension covers tenant safety (this
 *                            repository does NOT extend
 *                            `BaseRepository`).
 *
 *   - `sumMonthSpend`     — Returns the sum of `spentMicrocents` across
 *                            all bucket rows for the merchant from the
 *                            UTC start of the calendar month of `asOf`
 *                            through today. Used by the AI Worker's
 *                            pre-call spend-ceiling check against
 *                            `MerchantSettings.monthlyAiSpendCapCents`.
 *                            Prisma's typed `aggregate` preserves
 *                            BigInt precision natively — no raw-SQL
 *                            `::bigint` cast needed (the column is
 *                            already BIGINT, the JS-side type is
 *                            BigInt throughout).
 *
 * UTC discipline (§F-6 lines 244-246). The monthly cap is calendar-
 * month UTC, the daily-bucket key is UTC date. Merchant timezone is
 * NOT used for bucket period — operator merchant-local rollup
 * dashboards convert at read time. Both `getOrCreateForDay` and
 * `incrementSpend` truncate the input `date` to UTC midnight before
 * the upsert; `sumMonthSpend` computes the month-start as the first
 * day of `asOf`'s calendar month at UTC midnight. Inline helpers below
 * — no existing UTC-date helper anywhere in the workspace at the time
 * of writing (workspace-wide grep returned zero hits for
 * `Date.UTC(` / `getUTCMonth`).
 *
 * Scope semantics. `AiSpendBucket` is in `TENANT_SCOPED_MODELS` — the
 * Prisma extension auto-injects + asserts `merchantId` on every read
 * and write. Repository methods don't repeat that work. None of the
 * three methods carry a system-scope contract; no explicit
 * `getTenantScope` guard at method top.
 *
 * Transaction handling. Every method takes optional `tx`. The Epic F
 * batch 4 AI Worker passes one `tx` to AiGenerationRepo.markCompleted
 * + MessageRepo.updateGeneratedText + AiSpendBucketRepo.incrementSpend
 * at completion time so all three writes commit atomically.
 */
export class AiSpendBucketRepository {
  constructor(private readonly prisma: WinbackPrisma) {}

  /**
   * Returns the bucket-row id for `(merchantId, date-truncated-to-
   * UTC-midnight)`. Creates the row with zero balances if it doesn't
   * exist; otherwise returns the existing id without touching the
   * counters. Idempotent under concurrent first-callers via the
   * @@unique([merchantId, date]) synchronization point.
   */
  async getOrCreateForDay(
    args: GetOrCreateForDayArgs,
    tx?: Prisma.TransactionClient,
  ): Promise<{ bucketId: string }> {
    const client = tx ?? this.prisma;
    const utcMidnight = toUtcMidnight(args.date);
    const row = await client.aiSpendBucket.upsert({
      where: { merchantId_date: { merchantId: args.merchantId, date: utcMidnight } },
      create: {
        merchantId: args.merchantId,
        date: utcMidnight,
        // spentMicrocents + generationCount defaults to 0 per schema.
      },
      update: {},
      select: { id: true },
    });
    return { bucketId: row.id };
  }

  /**
   * Atomically increments `spentMicrocents` by `deltaMicrocents` and
   * `generationCount` by 1 on today's bucket row. Creates the row
   * with these initial values if it doesn't exist yet.
   *
   * Atomicity comes from Postgres's `INSERT ... ON CONFLICT DO UPDATE`
   * path — when the row already exists, the UPDATE acquires the
   * row-level lock at the @@unique index synchronization point, which
   * serialises concurrent `incrementSpend` calls for the same
   * `(merchantId, date)`. No lost updates even under burst writes
   * across multiple drainer worker replicas.
   *
   * BigInt precision: Prisma's `BigIntFieldUpdateOperationsInput.
   * increment` preserves precision through to the SQL UPDATE
   * (`spentMicrocents = spentMicrocents + $value`). The `deltaMicrocents`
   * caller passes is BigInt; the column is BigInt; nothing in the path
   * widens to Number.
   */
  async incrementSpend(
    args: IncrementSpendArgs,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    const utcMidnight = toUtcMidnight(args.date);
    await client.aiSpendBucket.upsert({
      where: { merchantId_date: { merchantId: args.merchantId, date: utcMidnight } },
      create: {
        merchantId: args.merchantId,
        date: utcMidnight,
        spentMicrocents: args.deltaMicrocents,
        generationCount: 1,
      },
      update: {
        spentMicrocents: { increment: args.deltaMicrocents },
        generationCount: { increment: 1 },
      },
    });
  }

  /**
   * Sums `spentMicrocents` across all bucket rows for `merchantId`
   * from the UTC start of `asOf`'s calendar month through the present.
   * Returns `0n` when no rows exist for the merchant in this window
   * (vs. throwing or returning `null`).
   *
   * Used by the AI Worker's pre-call spend-ceiling check against
   * `MerchantSettings.monthlyAiSpendCapCents` (per §F-5 / §F-6
   * "Ceiling enforcement — pre-call check"). The check happens BEFORE
   * the LLM call so a denied generation never spends money.
   *
   * BigInt boundary: Prisma's `aggregate._sum.spentMicrocents` is typed
   * `BigInt | null`. The null case is the no-rows path; we coerce to
   * `0n` to keep the caller's arithmetic monotonic.
   */
  async sumMonthSpend(
    args: SumMonthSpendArgs,
    tx?: Prisma.TransactionClient,
  ): Promise<bigint> {
    const client = tx ?? this.prisma;
    const monthStart = toUtcMonthStart(args.asOf);
    const result = await client.aiSpendBucket.aggregate({
      where: {
        merchantId: args.merchantId,
        date: { gte: monthStart },
      },
      _sum: { spentMicrocents: true },
    });
    return result._sum.spentMicrocents ?? 0n;
  }
}

// ---------------------------------------------------------------------------
// UTC-date helpers
//
// Inline here because workspace-wide grep at 2026-05-24 returned zero
// hits for `Date.UTC(` / `getUTCMonth` — no existing helper to reuse.
// If a future caller surfaces (Epic G dashboards, Epic H attribution
// rollups), promote both to a shared module — `packages/contracts/src/
// utc-date.ts` is the natural home given it's a pure utility used at
// the data/contract boundary.
//
// UTC choice rationale (per §F-6 lines 244-246): the monthly spend cap
// is calendar-month UTC; the daily-bucket key is UTC date. Merchant
// timezone is NOT used for bucket period — operator merchant-local
// rollup dashboards convert at read time. Using merchant timezone here
// would mean buckets straddle UTC midnight differently for each
// merchant, which (a) makes the cap math timezone-dependent (every
// merchant gets their cap reset at a different UTC instant), and (b)
// makes operator queries that aggregate across merchants meaningless.
// ---------------------------------------------------------------------------

/**
 * Truncates `date` to UTC midnight of the same calendar day. The
 * result's millisecond timestamp is the start of the UTC day, with
 * all time-of-day components zeroed.
 *
 * Example: `2026-06-15T14:23:45.123Z` → `2026-06-15T00:00:00.000Z`.
 *
 * Exported only for direct testing — production callers should use
 * the repository's methods, which apply this normalization internally.
 */
function toUtcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Returns the UTC midnight of the first day of `asOf`'s calendar
 * month.
 *
 * Example: `2026-06-15T14:23:45.123Z` → `2026-06-01T00:00:00.000Z`.
 *
 * Cross-month behaviour: for `asOf = 2026-12-31T23:59:59Z`, returns
 * `2026-12-01T00:00:00Z`. For January, returns
 * `<year>-01-01T00:00:00Z` — `Date.UTC(year, 0, 1)` because month is
 * zero-indexed.
 */
function toUtcMonthStart(asOf: Date): Date {
  return new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
}

// ---------------------------------------------------------------------------
// Public argument types
// ---------------------------------------------------------------------------

export interface GetOrCreateForDayArgs {
  readonly merchantId: string;
  /**
   * Any Date — repository truncates to UTC midnight before the upsert
   * key. Callers can pass `new Date()` (with time-of-day components)
   * without polluting the bucket key space.
   */
  readonly date: Date;
}

export interface IncrementSpendArgs {
  readonly merchantId: string;
  /** Truncated to UTC midnight internally. */
  readonly date: Date;
  /** Cost increment in microcents. BigInt per Architecture lock #2. */
  readonly deltaMicrocents: bigint;
}

export interface SumMonthSpendArgs {
  readonly merchantId: string;
  /**
   * Any Date — repository computes month-start as the first day of
   * `asOf`'s calendar month at UTC midnight, then sums all buckets
   * from that point forward.
   */
  readonly asOf: Date;
}
