/**
 * Closes B3 — integration tests for `OutboxRepository.claimBatch`.
 *
 * Why this file exists: `claimBatch` is the single load-bearing primitive
 * for the entire D2 outbox-drainer architecture (and by extension D3 cron
 * sweeps and H1 attribution dispatch). It uses `FOR UPDATE SKIP LOCKED` —
 * a subtle Postgres concurrency feature — and its semantics must be pinned
 * by execution, not assumption. Pre-D2 this primitive was untested; D1
 * closes that gap before any downstream code starts depending on it.
 *
 * Seven tests, one per critical invariant:
 *   1. system-scope assertion (cross-tenant safety boundary)
 *   2. createdAt ASC ordering   (oldest events drained first — fairness)
 *   3. limit handling           (default 100, custom limit respected)
 *   4. processedAt IS NULL      (idempotent re-runs don't re-drain)
 *   5. concurrent SKIP LOCKED   (THE load-bearing concurrency property —
 *                                two drainer replicas claim disjoint sets)
 *   6. commit-without-mark       (locks release on commit even if the
 *                                drainer forgot markProcessed — backstop)
 *   7. rollback                  (locks release on rollback — error path)
 *
 * Why 7 instead of smoke.test.ts's cap of 6: smoke.test.ts caps because
 * it is a smoke baseline, not a primitive-specific suite. claimBatch is
 * a domain primitive with multiple distinct invariants; splitting them
 * gives precise failure signals when one regresses.
 *
 * Harness: real Postgres via `pnpm db:test`. Uses `singleFork: true`
 * (vitest.integration.config.ts) — tests serialize, no cross-test races.
 */

import { Prisma } from '@prisma/client';
import { OUTBOX_EVENTS } from '@winback/contracts';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { OutboxRepository, withSystemScope, withTenantScope } from '../../src/index.js';
import { createTestMerchant, getTestClient, resetDb } from './setup.js';

const SHOP = 'outbox-claim-batch.myshopify.com';

const prisma = getTestClient();
const repo = new OutboxRepository(prisma);
let merchantId: string;

beforeAll(async () => {
  await resetDb();
  merchantId = await createTestMerchant(SHOP);
});

beforeEach(async () => {
  // Clear only OutboxEvent rows for this merchant — other state (Merchant,
  // Settings, etc.) is shared across the suite.
  await withSystemScope('test.cleanup_per_test', async () => {
    await prisma.outboxEvent.deleteMany({ where: { merchantId } });
  });
});

// ===========================================================================
// Inline helpers (Q2-b: one file, one use — keep them here, not in setup.ts)
// ===========================================================================

/**
 * Seeds N OutboxEvent rows for the test merchant. Returns ids + createdAt in
 * insertion order. Per-row create so we can return ids; the largest seeded
 * count in any test here is 10, comfortable under the 30s test timeout.
 *
 * Pass `explicitTimestamps: true` to override the schema's `@default(now())`
 * with deterministic 1-second-apart timestamps. Used by the ordering test
 * (test 2) to avoid relying on Postgres `NOW()` resolution across the small
 * gap between successive single-row transactions.
 */
async function seedEvents(
  count: number,
  opts?: { explicitTimestamps?: boolean },
): Promise<{ id: string; createdAt: Date }[]> {
  return withSystemScope('test.seed_outbox', async () => {
    const created: { id: string; createdAt: Date }[] = [];
    const baseTime = new Date('2026-01-01T00:00:00Z');
    for (let i = 0; i < count; i++) {
      const data: Prisma.OutboxEventUncheckedCreateInput = {
        merchantId,
        type: OUTBOX_EVENTS.customer.created,
        payload: { idx: i } as Prisma.InputJsonValue,
      };
      if (opts?.explicitTimestamps === true) {
        data.createdAt = new Date(baseTime.getTime() + i * 1000);
      }
      const row = await prisma.outboxEvent.create({
        data,
        select: { id: true, createdAt: true },
      });
      created.push(row);
    }
    return created;
  });
}

/**
 * Promise-based barrier for the concurrency test. Two coroutines coordinate
 * by awaiting each other's "I've reached this point" signal, so tx A can
 * hold its row-level locks while tx B claims its (disjoint) batch.
 *
 * Inline rather than in setup.ts — only test 5 uses it.
 */
interface Barrier {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}
function createBarrier(): Barrier {
  let resolveFn!: () => void;
  const promise = new Promise<void>((r) => {
    resolveFn = r;
  });
  return { promise, resolve: resolveFn };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('OutboxRepository.claimBatch', () => {
  it('1. throws when not in system scope', async () => {
    // No scope at all — `getTenantScope()` returns undefined, scope.kind is
    // never 'system', method throws.
    await expect(
      prisma.$transaction((tx) => repo.claimBatch(tx as unknown as Prisma.TransactionClient,5)),
    ).rejects.toThrow(/system scope/);

    // Tenant scope is also not system scope — must reject. Pins the
    // cross-tenant safety boundary: a request in tenant context cannot
    // accidentally drain another tenant's outbox.
    await expect(
      withTenantScope(merchantId, () =>
        prisma.$transaction((tx) => repo.claimBatch(tx as unknown as Prisma.TransactionClient,5)),
      ),
    ).rejects.toThrow(/system scope/);
  });

  it('2. returns rows ordered by createdAt ASC', async () => {
    const seeded = await seedEvents(5, { explicitTimestamps: true });
    const expectedIdsByTime = seeded.map((r) => r.id);

    const result = await withSystemScope('test.claim_ordered', () =>
      prisma.$transaction((tx) => repo.claimBatch(tx as unknown as Prisma.TransactionClient,5)),
    );

    expect(result).toHaveLength(5);
    // Exact order match — claimBatch's `ORDER BY "createdAt"` must surface
    // the oldest event first so a steady-state drainer is FIFO.
    expect(result.map((r) => r.id)).toEqual(expectedIdsByTime);
  });

  it('3. honors the limit parameter (default 100, custom respected)', async () => {
    // 150 rows — more than the default limit so we can observe truncation.
    // createMany used here (vs. seedEvents) because we don't need ids back.
    await withSystemScope('test.seed_bulk', async () => {
      await prisma.outboxEvent.createMany({
        data: Array.from({ length: 150 }, (_, i) => ({
          merchantId,
          type: OUTBOX_EVENTS.customer.created,
          payload: { idx: i } as Prisma.InputJsonValue,
        })),
      });
    });

    // Default limit: claimBatch(tx) → 100.
    const defaultResult = await withSystemScope('test.claim_default_limit', () =>
      prisma.$transaction((tx) => repo.claimBatch(tx as unknown as Prisma.TransactionClient)),
    );
    expect(defaultResult).toHaveLength(100);

    // Custom limit: claimBatch(tx, 25) → 25.
    const customResult = await withSystemScope('test.claim_custom_limit', () =>
      prisma.$transaction((tx) => repo.claimBatch(tx as unknown as Prisma.TransactionClient,25)),
    );
    expect(customResult).toHaveLength(25);
  });

  it('4. excludes rows where processedAt IS NOT NULL', async () => {
    const seeded = await seedEvents(10);
    const processedIds = seeded.slice(0, 5).map((r) => r.id);
    const unprocessedIds = seeded.slice(5).map((r) => r.id);

    // Mark half the rows processed.
    await withSystemScope('test.mark_processed', async () => {
      await prisma.outboxEvent.updateMany({
        where: { id: { in: processedIds } },
        data: { processedAt: new Date() },
      });
    });

    // Claim with a limit larger than the unprocessed count to prove the
    // exclusion is a filter, not a coincidence of limit.
    const result = await withSystemScope('test.claim_filter', () =>
      prisma.$transaction((tx) => repo.claimBatch(tx as unknown as Prisma.TransactionClient,20)),
    );

    expect(result).toHaveLength(5);
    expect(result.map((r) => r.id).sort()).toEqual([...unprocessedIds].sort());
  });

  it('5. concurrent transactions claim disjoint batches (FOR UPDATE SKIP LOCKED)', async () => {
    await seedEvents(10);

    // Barrier orchestration:
    //   A claims first, signals it has its locks, then waits for B.
    //   B waits for A's signal, claims its (disjoint) batch, signals A to commit.
    //   A's commit releases its locks; B's commit releases its.
    //   The disjointness is the load-bearing property — SKIP LOCKED means
    //   B skips the rows A has locked, so it picks up the next 5 instead.
    const aClaimed = createBarrier();
    const bClaimed = createBarrier();

    const [batchA, batchB] = await withSystemScope('test.claim_concurrent', () =>
      Promise.all([
        prisma.$transaction(
          async (txA) => {
            const batch = await repo.claimBatch(txA as unknown as Prisma.TransactionClient,5);
            aClaimed.resolve();
            await bClaimed.promise; // hold txA's locks until B has claimed
            return batch;
          },
          // 15s overrides Prisma 5's default 5s tx timeout — the barrier
          // wait dominates and we want headroom on slow CI. Sits well under
          // vitest.integration.config.ts's 30s hook timeout.
          { timeout: 15_000 },
        ),
        prisma.$transaction(
          async (txB) => {
            await aClaimed.promise; // wait for A to hold its locks first
            const batch = await repo.claimBatch(txB as unknown as Prisma.TransactionClient,5);
            bClaimed.resolve();
            return batch;
          },
          { timeout: 15_000 },
        ),
      ]),
    );

    expect(batchA).toHaveLength(5);
    expect(batchB).toHaveLength(5);
    // The two batches must be disjoint — if SKIP LOCKED regresses (e.g. a
    // future refactor swaps in plain FOR UPDATE), one tx would block on the
    // other's locks, blow the 15s timeout, and the assertion would surface
    // as a hung test rather than a wrong-count test. Either failure mode
    // catches the regression.
    const combinedIds = new Set([...batchA, ...batchB].map((r) => r.id));
    expect(combinedIds.size).toBe(10); // disjoint cover of all 10 seeded
  });

  it('6. committed tx without markProcessed: locks release and rows are reclaimable by next drainer pass (crash-recovery semantics)', async () => {
    const seeded = await seedEvents(3);
    const seededIds = seeded.map((r) => r.id).sort();

    // First claim — commits without calling markProcessed. In production
    // the drainer commits in the SAME tx as markProcessed (so a crash
    // before commit rolls back the claim too). But if a future code path
    // commits without markProcessed (drainer variant that defers the mark,
    // a programmer error, a partial implementation), the lock-release
    // semantic backstops correctness: the rows are still claimable next
    // pass and no events are silently lost.
    const firstBatch = await withSystemScope('test.claim_first_pass', () =>
      prisma.$transaction((tx) => repo.claimBatch(tx as unknown as Prisma.TransactionClient,10)),
    );
    expect(firstBatch).toHaveLength(3);

    // Second claim — rows were never marked processed; tx-commit released
    // the row-level locks; they must be reclaimable.
    const secondBatch = await withSystemScope('test.claim_second_pass', () =>
      prisma.$transaction((tx) => repo.claimBatch(tx as unknown as Prisma.TransactionClient,10)),
    );
    expect(secondBatch.map((r) => r.id).sort()).toEqual(seededIds);
  });

  it('7. rolled-back tx: locks release and rows are reclaimable (error-recovery semantics)', async () => {
    const seeded = await seedEvents(3);
    const seededIds = seeded.map((r) => r.id).sort();

    // Claim then throw — Prisma rolls back the tx. Row-level locks must
    // release immediately so a subsequent drainer pass picks up the same
    // rows (no silent loss).
    await expect(
      withSystemScope('test.claim_then_throw', () =>
        prisma.$transaction(async (tx) => {
          const batch = await repo.claimBatch(tx as unknown as Prisma.TransactionClient,10);
          expect(batch).toHaveLength(3);
          throw new Error('simulated drainer error mid-batch');
        }),
      ),
    ).rejects.toThrow('simulated drainer error mid-batch');

    // Recovery claim — rollback released the locks; rows are claimable.
    const recoveryBatch = await withSystemScope('test.claim_recovery', () =>
      prisma.$transaction((tx) => repo.claimBatch(tx as unknown as Prisma.TransactionClient,10)),
    );
    expect(recoveryBatch.map((r) => r.id).sort()).toEqual(seededIds);
  });
});
