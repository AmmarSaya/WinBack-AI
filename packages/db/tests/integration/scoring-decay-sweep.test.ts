/**
 * Integration tests for the decay-rescore sweep against real Postgres — the
 * first leg of the phased lapsed→sent full-harness build (Phase 1).
 *
 * This suite proves the SCORING half of the harness: a seeded lapsed customer
 * (rDays=120, `at_risk` band) is transitioned from `active` to `at_risk` by
 * the SAME `runDecaySweep` function the daily 03:00 cron calls, running
 * against real Postgres with a pinned clock. Dispatch/generation/send are
 * later phases; this file does NOT wire them.
 *
 * The mocked-Prisma unit tests in `customer-score-service.test.ts` cannot
 * cover:
 *   - The raw-SQL cohort read (`::bigint` cast, `COALESCE` recency, 365d
 *     window binding, tenant filter) — mocks stub `readCohort` entirely.
 *   - The cross-tenant `SELECT id FROM "Merchant" WHERE ...` inside
 *     `runDecaySweep` — mocks return a fixed list.
 *   - The `scoringInitializedAt IS NOT NULL` selectivity — same reason.
 *   - The Prisma tenant-scope extension's write-hook (8.4 Lesson 2: bare
 *     writes raise `TenantScopeError`) — the mocked client is `{}`.
 *   - The `INSUFFICIENT_COHORT_THRESHOLD = 5` boundary — mocks control the
 *     cohort return value directly.
 *   - The `customer.state_changed` OutboxEvent + AuditLog persisted-shape —
 *     the exact payload/context format phase 3's OutboxEvent consumer will
 *     Zod-parse on read.
 *
 * This is exactly what Phase 1 is for — see the Phase-1 surface for the
 * ruled-in cohort-threshold catch, tenant-scope catch, and clock-coupling
 * catch. Real PG proves them once, permanently.
 *
 * PINNED-CLOCK CONTRACT (load-bearing, no tolerance). Every seed timestamp
 * is relative to the exact `NOW` constant below; the sweep sees the exact
 * same `NOW` via `vi.setSystemTime(NOW)`. The `decayRescore` service method
 * calls `new Date()` inline (`customer-score.service.ts:698`) when no
 * `now` is threaded through; the fake-timer mock intercepts that call
 * globally within the test process. `runDecaySweep` does NOT accept a
 * `now` arg — it relies on this global interception. The happy-path
 * assertion `rDays === 120` is STRICT, no `±` tolerance: if the fake
 * clock does not reach the sweep, this test fails LOUDLY, and the fix
 * per Phase-1 rulings is to THREAD `now` through `runDecaySweep →
 * decayRescore` — never to relax the assertion.
 *
 * CROSS-PACKAGE IMPORT (Option A, ruled during Phase 1). This file lives
 * in `packages/db/tests/integration/` but imports `runDecaySweep` from
 * `apps/scheduler/src/handlers/decay-sweep.ts` via a relative path. This
 * INVERTS the normal workspace dep direction (`apps/scheduler` depends
 * on `@winback/db`, not the reverse) — permitted here because:
 *   - Test files are excluded from `packages/db/tsconfig.json`'s `include`
 *     (which only covers the src/ tree), so no TS project-reference cycle
 *     is introduced.
 *   - `apps/scheduler` is NOT added to `packages/db/package.json` deps or
 *     devDeps, so no runtime package-manifest cycle.
 *   - Vitest resolves the source directly via its own transformer; no
 *     built-graph coupling.
 *   - `apps/scheduler/src/handlers/decay-sweep.ts` re-imports
 *     `@winback/db` at runtime, which resolves to `packages/db/dist/`;
 *     `db-test.mjs` step 1/4 runs `pnpm build` first, so the dist is
 *     current at test-time.
 *   - The `globalThis.__winbackScopeStore` pattern (`tenant-scope.ts:139`)
 *     ensures the ALS is shared between src-loaded and dist-loaded
 *     modules — the sweep's `withSystemScope`/`withTenantScope` (from
 *     dist) and this file's helpers (from src) hit the same store.
 *
 * The alternative (Option C — reconstruct the sweep inline in the test)
 * was rejected in Phase 1 because it would skip the cross-tenant
 * `$queryRaw` SELECT and the `scoringInitializedAt` selectivity — both
 * things this batch specifically exists to prove against real PG.
 *
 * Gate delta: db:test 48 → 51 (+3):
 *   1. Happy path — active → at_risk with STRICT rDays === 120 + all five
 *      assertion reads.
 *   2. Idempotency — a second sweep pass AT AN ADVANCED CLOCK re-evaluates
 *      the target (witnessed by `CustomerScore.computedAt` advancing to the
 *      new `now`) and correctly SUPPRESSES the re-emit (zero additional
 *      AuditLog / OutboxEvent rows, target stays `at_risk`). The clock
 *      advance is what separates "re-examined + band guard suppressed the
 *      duplicate" from "wasn't examined at all" — a same-clock re-run
 *      could produce identical counts for the wrong reason (target fell
 *      out of the working set / cohort read differed / computedAt is
 *      frozen). Advancing NOW by 1h is deep inside the 91-180d `at_risk`
 *      band (rDays 120 → still 120), so the band stays unchanged and
 *      only the transition-reaction suppression is under test. This is
 *      the property phase 3's OutboxEvent consumer depends on —
 *      double-emit → double-generate.
 *   3. `scoringInitializedAt` gate — an un-initialized merchant is skipped
 *      by the cross-tenant SELECT; zero writes to its customers, zero
 *      CustomerScore rows, zero AuditLog, zero OutboxEvent.
 *
 * The last two pin properties of the SCORING sweep that have no home in
 * later phases; deferring them risks they're never written.
 */

import { AUDIT_ACTIONS, OUTBOX_EVENTS } from '@winback/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SchedulerContext } from '../../../../apps/scheduler/src/context.js';
import { runDecaySweep } from '../../../../apps/scheduler/src/handlers/decay-sweep.js';

import { withSystemScope } from '../../src/index.js';
import { assertRead, createTestMerchant, getTestClient, resetDb } from '../../src/test-utils.js';

// ---------------------------------------------------------------------------
// Pinned clock + seed constants
// ---------------------------------------------------------------------------

/**
 * The single anchor instant for every seed timestamp AND the sweep's
 * observed `now`. Chosen mid-2026 to sit comfortably in the future of
 * fixture time and far from DST edges (UTC midday).
 *
 * If the fake clock does not reach the sweep, the strict rDays === 120
 * assertion below fails LOUDLY — the phase-1 ruling forbids swapping in
 * a tolerance. The fix would be to thread `now` through
 * `runDecaySweep → decayRescore`, not to relax this constant.
 */
const NOW = new Date('2026-07-15T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Target seed: placed 120 days before NOW.
 * `stateFromRecency(120)` → 91 ≤ 120 ≤ 180 → `at_risk`. Well inside the
 * 365d cohort window (no boundary interaction) and well below the >365d
 * `lost` cliff — the safest lapsed band to target.
 */
const TARGET_R_DAYS = 120;

/**
 * Filler seed: placed 5 days before NOW.
 * `stateFromRecency(5)` → `active`. Fillers exist ONLY to lift the cohort
 * above `INSUFFICIENT_COHORT_THRESHOLD = 5` — with a lone target the
 * whole cohort would route to `insufficient_data` and the sweep's
 * working-set filter would skip the target entirely (Phase-1 risk #1).
 */
const FILLER_R_DAYS = 5;

const SHOP_INITIALIZED = 'scoring-decay-sweep-initialized.myshopify.com';
const SHOP_UNINITIALIZED = 'scoring-decay-sweep-uninitialized.myshopify.com';

// ---------------------------------------------------------------------------
// Shared harness state
// ---------------------------------------------------------------------------

const prisma = getTestClient();

/** Minimal SchedulerContext — the sweep only reads `ctx.prisma`. */
const ctx = { prisma } as unknown as SchedulerContext;

let merchantId: string;
let targetCustomerId: string;
let fillerCustomerIds: string[];

// ---------------------------------------------------------------------------
// Seed helpers — ALL writes go through withSystemScope (8.4 Lesson 2)
// ---------------------------------------------------------------------------

async function seedCustomer(shopifyCustomerId: string): Promise<string> {
  return withSystemScope('test.seed_customer', async () => {
    const c = await prisma.customer.create({
      data: {
        merchantId,
        shopifyCustomerId,
        email: `${shopifyCustomerId.split('/').pop() ?? 'x'}@example.com`,
        // Schema default is `active`; explicit here because it's
        // load-bearing — the sweep's working-set filter is
        // `state IN (active, warm, at_risk, dormant)`. A row seeded
        // outside the working set would be silently skipped.
        state: 'active',
      },
      select: { id: true },
    });
    return c.id;
  });
}

async function seedPaidOrder(args: {
  customerId: string;
  shopifyOrderId: string;
  placedAt: Date;
}): Promise<void> {
  await withSystemScope('test.seed_order', async () => {
    await prisma.order.create({
      data: {
        merchantId,
        customerId: args.customerId,
        shopifyOrderId: args.shopifyOrderId,
        currency: 'USD',
        totalAmountCents: 1000n,
        subtotalAmountCents: 1000n,
        // Cohort SQL filters `financialStatus = 'paid' AND isTest = false`.
        // Any other combination drops the row from the cohort → target
        // becomes a lurker → wrong band math.
        financialStatus: 'paid',
        isTest: false,
        placedAt: args.placedAt,
        // Explicit null. The cohort SQL uses
        // `COALESCE(shopifyProcessedAt, placedAt)` for R math; null here
        // forces the fallback to `placedAt`, matching the seed intent.
        shopifyProcessedAt: null,
      },
    });
  });
}

/**
 * Full 6-customer cohort: target at rDays=120 + 5 fillers at rDays=5.
 * Uses the module-level `merchantId` (must be set by the caller's
 * beforeEach).
 */
async function seedCohort(): Promise<void> {
  targetCustomerId = await seedCustomer('gid://shopify/Customer/target');
  await seedPaidOrder({
    customerId: targetCustomerId,
    shopifyOrderId: 'gid://shopify/Order/target',
    placedAt: new Date(NOW.getTime() - TARGET_R_DAYS * DAY_MS),
  });

  fillerCustomerIds = [];
  for (let i = 1; i <= 5; i++) {
    const id = await seedCustomer(`gid://shopify/Customer/filler-${String(i)}`);
    fillerCustomerIds.push(id);
    await seedPaidOrder({
      customerId: id,
      shopifyOrderId: `gid://shopify/Order/filler-${String(i)}`,
      placedAt: new Date(NOW.getTime() - FILLER_R_DAYS * DAY_MS),
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runDecaySweep — real Postgres (integration)', () => {
  beforeEach(async () => {
    await resetDb();
    // Order matters: fake timers active BEFORE any seed write, so
    // `createTestMerchant`'s internal `new Date()` for `installedAt` and
    // `scoringInitializedAt` resolves to NOW. This aligns the seed clock
    // with the sweep clock end-to-end.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('happy path — initialized merchant, target crosses active → at_risk', () => {
    beforeEach(async () => {
      // Default `scoringInitializedAt = new Date()` = NOW (initialized).
      merchantId = await createTestMerchant(SHOP_INITIALIZED);
      await seedCohort();
    });

    it('transitions target to at_risk with rDays === 120 STRICT and emits customer.state_changed once', async () => {
      await runDecaySweep(ctx);

      // (1) Target Customer.state.
      const target = await assertRead(() =>
        prisma.customer.findUnique({
          where: { id: targetCustomerId },
          select: { state: true },
        }),
      );
      expect(target?.state).toBe('at_risk');

      // (2) CustomerScore — STRICT rDays === 120 is the clock checkpoint.
      const score = await assertRead(() =>
        prisma.customerScore.findUnique({
          where: { customerId: targetCustomerId },
        }),
      );
      expect(score).not.toBeNull();
      expect(score?.rDays).toBe(120);
      expect(score?.fCount).toBe(1);
      expect(score?.mCents).toBe(1000n);
      expect(score?.currency).toBe('USD');
      // `computedAt === NOW` is the second, independent clock-reach
      // assertion: it directly reads the `now` the sweep threaded into
      // `upsertScore.computedAt`. If this ever equals wall-clock instead
      // of NOW, the fake-timer path has broken.
      expect(score?.computedAt.toISOString()).toBe(NOW.toISOString());

      // (3) AuditLog — proves the emission gate opened (transition
      // reaction side-effect fired) AND the in-tx audit + outbox pair
      // both landed under the same tx.
      const audit = await assertRead(() =>
        prisma.auditLog.findFirst({
          where: {
            merchantId,
            action: AUDIT_ACTIONS.customer.state_changed,
            targetId: targetCustomerId,
          },
        }),
      );
      expect(audit).not.toBeNull();
      const auditContext = audit?.context as {
        oldState: string;
        newState: string;
        trigger: string;
        rDays: number;
      };
      expect(auditContext.oldState).toBe('active');
      expect(auditContext.newState).toBe('at_risk');
      // `trigger: 'decay_sweep'` is the discriminator that separates
      // decay-sweep transitions from webhook-driven `recompute`
      // transitions in the audit trail.
      expect(auditContext.trigger).toBe('decay_sweep');
      expect(auditContext.rDays).toBe(120);

      // (4) OutboxEvent — the seam phase 3's dispatch worker will
      // consume. Payload shape is what Zod-parses on the consumer side.
      const outbox = await assertRead(() =>
        prisma.outboxEvent.findFirst({
          where: {
            merchantId,
            type: OUTBOX_EVENTS.customer.state_changed,
          },
        }),
      );
      expect(outbox).not.toBeNull();
      const outboxPayload = outbox?.payload as {
        customerId: string;
        oldState: string;
        newState: string;
      };
      expect(outboxPayload.customerId).toBe(targetCustomerId);
      expect(outboxPayload.oldState).toBe('active');
      expect(outboxPayload.newState).toBe('at_risk');

      // (5) Selectivity — fillers stayed `active`, only ONE audit +
      // ONE outbox row exist for this merchant. Proves the sweep did
      // NOT touch the 5 unchanged customers' side-effects.
      const fillers = await assertRead(() =>
        prisma.customer.findMany({
          where: { id: { in: fillerCustomerIds } },
          select: { id: true, state: true },
        }),
      );
      expect(fillers).toHaveLength(5);
      for (const f of fillers) {
        expect(f.state).toBe('active');
      }

      const auditCount = await assertRead(() =>
        prisma.auditLog.count({
          where: {
            merchantId,
            action: AUDIT_ACTIONS.customer.state_changed,
          },
        }),
      );
      expect(auditCount).toBe(1);

      const outboxCount = await assertRead(() =>
        prisma.outboxEvent.count({
          where: {
            merchantId,
            type: OUTBOX_EVENTS.customer.state_changed,
          },
        }),
      );
      expect(outboxCount).toBe(1);
    });

    it('is idempotent — a second sweep at an ADVANCED clock re-evaluates the target (computedAt advances) but suppresses the duplicate emit', async () => {
      // Pass 1 at NOW — transitions target, emits one event, upserts
      // CustomerScore with `computedAt = NOW`.
      await runDecaySweep(ctx);

      const scoreAfterPass1 = await assertRead(() =>
        prisma.customerScore.findUnique({
          where: { customerId: targetCustomerId },
        }),
      );
      expect(scoreAfterPass1?.computedAt.toISOString()).toBe(NOW.toISOString());

      const firstAuditCount = await assertRead(() =>
        prisma.auditLog.count({
          where: { merchantId, action: AUDIT_ACTIONS.customer.state_changed },
        }),
      );
      expect(firstAuditCount).toBe(1);

      const firstOutboxCount = await assertRead(() =>
        prisma.outboxEvent.count({
          where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
        }),
      );
      expect(firstOutboxCount).toBe(1);

      // Advance the pinned clock by 1h — deep inside the 91-180d
      // `at_risk` band (rDays 120 → still 120 after floor, band
      // unchanged). This gives the 2nd sweep a DIFFERENT `now` value;
      // if the sweep re-examined the target, its unconditional
      // `upsertScore` call (customer-score.service.ts:782-795, before
      // the state==newState continue guard) writes
      // `computedAt = NOW + 1h`. If the sweep did NOT re-examine the
      // target (fell out of the working set / cohort read differed),
      // `computedAt` stays at NOW.
      //
      // This is the witness the founder's pre-commit audit added:
      // count-stays-at-1 alone is ambiguous — it could mean
      // "re-examined + band guard suppressed" OR "wasn't examined at
      // all." Advancing the clock separates the two.
      const NOW_PLUS_1H = new Date(NOW.getTime() + 60 * 60 * 1000);
      vi.setSystemTime(NOW_PLUS_1H);

      await runDecaySweep(ctx);

      // WITNESS: 2nd sweep re-evaluated the target — computedAt
      // advanced to NOW+1h. rDays still 120 (band unchanged; the point
      // of the small delta).
      const scoreAfterPass2 = await assertRead(() =>
        prisma.customerScore.findUnique({
          where: { customerId: targetCustomerId },
        }),
      );
      expect(scoreAfterPass2?.computedAt.toISOString()).toBe(NOW_PLUS_1H.toISOString());
      expect(scoreAfterPass2?.rDays).toBe(120);

      // TRANSITION-REACTION SUPPRESSED: state stays at_risk, NO second
      // audit row, NO second outbox row. This is the actual
      // idempotency property phase 3's OutboxEvent consumer relies on.
      const targetAfter = await assertRead(() =>
        prisma.customer.findUnique({
          where: { id: targetCustomerId },
          select: { state: true },
        }),
      );
      expect(targetAfter?.state).toBe('at_risk');

      const secondAuditCount = await assertRead(() =>
        prisma.auditLog.count({
          where: { merchantId, action: AUDIT_ACTIONS.customer.state_changed },
        }),
      );
      expect(secondAuditCount).toBe(1);

      const secondOutboxCount = await assertRead(() =>
        prisma.outboxEvent.count({
          where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
        }),
      );
      expect(secondOutboxCount).toBe(1);
    });
  });

  describe('scoringInitializedAt gate — un-initialized merchant is skipped', () => {
    beforeEach(async () => {
      // Explicit `scoringInitializedAt: null` — un-initialized.
      merchantId = await createTestMerchant(SHOP_UNINITIALIZED, {
        scoringInitializedAt: null,
      });
      await seedCohort();
    });

    it('the sweep does not touch an un-initialized merchant: 0 CustomerScore, 0 AuditLog, 0 OutboxEvent, target stays active', async () => {
      await runDecaySweep(ctx);

      // Target state unchanged — `active` (the seeded initial state).
      const target = await assertRead(() =>
        prisma.customer.findUnique({
          where: { id: targetCustomerId },
          select: { state: true },
        }),
      );
      expect(target?.state).toBe('active');

      // CustomerScore rows never created for this merchant. The sweep's
      // cross-tenant SELECT (`decay-sweep.ts:81-87`) filters
      // `scoringInitializedAt IS NOT NULL`, so this merchant never
      // enters the per-merchant loop. `readCohort` + `upsertScore` are
      // never invoked → zero score rows.
      const scoreCount = await assertRead(() =>
        prisma.customerScore.count({ where: { merchantId } }),
      );
      expect(scoreCount).toBe(0);

      const auditCount = await assertRead(() =>
        prisma.auditLog.count({
          where: {
            merchantId,
            action: AUDIT_ACTIONS.customer.state_changed,
          },
        }),
      );
      expect(auditCount).toBe(0);

      const outboxCount = await assertRead(() =>
        prisma.outboxEvent.count({
          where: {
            merchantId,
            type: OUTBOX_EVENTS.customer.state_changed,
          },
        }),
      );
      expect(outboxCount).toBe(0);
    });
  });
});
