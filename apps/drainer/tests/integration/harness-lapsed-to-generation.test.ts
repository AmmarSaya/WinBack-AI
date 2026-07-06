/**
 * Integration test for the LAPSED → GENERATION seam — Phase 2 of the
 * phased lapsed→sent full-harness build.
 *
 * Chains onto Phase 1 (`packages/db/tests/integration/scoring-decay-sweep.test.ts`,
 * merged as `4e88356`) by seeding a lapsed customer whose real
 * decay-rescore sweep emits a `customer.state_changed` OutboxEvent,
 * then exercises the drain path THAT HAS NEVER RUN END-TO-END AGAINST
 * REAL POSTGRES:
 *
 *   real sweep (scheduler)
 *     → OutboxEvent emitted with the real producer payload
 *       (`buildCustomerStateChangedPayload`, Postgres-persisted)
 *   → real `runDrainTick` (drainer)
 *     → real `dispatchEvent` router
 *       → real `handleCustomerStateChanged` handler
 *         → real `customerStateChangedPayloadSchema.parse` (§F-9 step 1)
 *         → real gate chain (billing / merchant / settings / rate-limit
 *           (real Redis) / spend-cap (real PG))
 *         → real 2-write atomic tx (`AiGeneration(pending)` + `Message(draft)`)
 *         → enqueue to STUB queue (BullMQ Worker itself is unit-tested)
 *   → real `processAiGenerateJob` worker (invoked manually with the
 *     captured payload, mirroring `ai-generate.test.ts`'s Q-I1(β) scope
 *     decision — direct invocation, not real BullMQ)
 *     → mocked `selectActiveProvider(...).generate(...)` returns
 *       deterministic content (mocked, NOT a real LLM call — see §2 of
 *       the Phase 2 surface: cost + non-determinism + flakiness)
 *     → real 3-write completion tx (`markCompleted` +
 *       `updateGeneratedText` + `incrementSpend`)
 *
 * WHY THIS SEAM EXISTS.
 *
 * The mocked-Prisma unit tests in
 * `apps/drainer/tests/handlers/customer-state-changed.test.ts` and the
 * existing real-PG suite in
 * `apps/drainer/tests/integration/ai-generate.test.ts` both bypass
 * `runDrainTick` + `dispatchEvent` and invoke `handleCustomerStateChanged`
 * directly on a hand-fed `OutboxEventRow`. That pattern has proven the
 * handler in isolation — but it CANNOT prove that:
 *
 *   1. The real sweep's OutboxEvent payload (written by
 *      `buildCustomerStateChangedPayload` at
 *      `packages/db/src/events/customer-state-changed.ts`) is parseable
 *      by the real consumer's Zod schema
 *      (`customerStateChangedPayloadSchema.parse(row.payload)` at
 *      `apps/drainer/src/handlers/customer-state-changed.ts:104`).
 *      A producer/consumer drift ONLY surfaces when a real
 *      PG-persisted payload flows through the real drain path.
 *   2. The `runDrainTick` → `withSystemScope('outbox.drain')` +
 *      `dispatch` → `handleCustomerStateChanged` → `withTenantScope`
 *      nested scope chain runs cleanly on real PG under the tenant-scope
 *      Prisma extension. Mocked Prisma completely bypasses the extension.
 *   3. The full pipeline lands a `Message` row at `status='draft'` with
 *      NON-EMPTY `generatedText` — the exact precondition Phase 3's
 *      dispatch pickup SQL requires (`AND generatedText <> ''`).
 *
 * Phase 2 proves LEG 2 OF 3. It does NOT prove scoring→generation→
 * dispatch→sent end-to-end. Phase 3 (dispatch seam) still ahead.
 *
 * SEED-CONSISTENCY CLOCK PIN — today@noon UTC via
 * `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(...)`.
 * Applied per the handoff carry-forward lesson landed in PR #123:
 * this file's seeds use Prisma `@default(now())` (Postgres clock), so a
 * fixed-past pin would open a JS/Postgres clock gap. Today@noon keeps
 * JS within hours of Postgres. NOT because a time-of-day gate lives in
 * this pipeline (freshness / frequency / quota gates are dispatch
 * concerns — Phase 3, not here); purely for seed-consistency (the
 * sweep's `now` inside `decayRescore` reads JS `new Date()`, and the
 * seed's Order `placedAt` timestamps are computed relative to the same
 * pinned instant). `toFake: ['Date']` (not the default full timer set)
 * matters: setTimeout stays real so the rate-limiter's Redis pipeline
 * / any queue-internal delays / worker retries do not stall.
 *
 * CROSS-PACKAGE IMPORT (second-of-kind — first was Phase 1's).
 * This file lives in `apps/drainer/tests/integration/` but imports
 * `runDecaySweep` from `apps/scheduler/src/handlers/decay-sweep.ts` via
 * relative path. Same pattern Phase 1 established:
 *   - Test files are excluded from `apps/drainer/tsconfig.json`'s
 *     `include` (src/ tree only), so no TS project-reference cycle.
 *   - `apps/scheduler` is NOT added to `apps/drainer/package.json` deps
 *     or devDeps; no runtime manifest cycle.
 *   - Vitest resolves the source directly via its own transformer.
 *   - `apps/scheduler`'s own `@winback/db` import resolves to
 *     `packages/db/dist` at test-time (fresh via `drainer-test.mjs` /
 *     the top-level `pnpm build` step).
 *   - `globalThis.__winbackScopeStore` (`tenant-scope.ts:139`) ensures
 *     the ALS is shared between src-loaded and dist-loaded modules.
 *
 * Gate delta: `drainer:test` 63 → 64 (+1, happy path only). Founder
 * ruling: unlike Phase 1's +3, the negatives here (rate-limit,
 * spend-cap, non-winback state gate) are already covered by
 * `ai-generate.test.ts` with hand-fed events — the handler's bail
 * logic is identical whether the event is hand-fed or drain-delivered,
 * so re-running via the drain path adds volume, not coverage. +1
 * proves the one never-proven thing (the producer/consumer seam).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — MUST hoist above the static imports below (vitest hoisting
// mechanics; same posture as `ai-generate.test.ts:52-63`).
// ---------------------------------------------------------------------------

vi.mock('@winback/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@winback/ai')>();
  return { ...actual, selectActiveProvider: vi.fn() };
});

vi.mock('@winback/shopify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@winback/shopify')>();
  return {
    ...actual,
    buildAdminClient: vi.fn(() => ({})),
  };
});

// ---------------------------------------------------------------------------
// Imports — AFTER mocks
// ---------------------------------------------------------------------------

import {
  type AiGenerateArgs,
  type AiGenerateResult,
  selectActiveProvider,
} from '@winback/ai';
import { AUDIT_ACTIONS, OUTBOX_EVENTS } from '@winback/contracts';
import { withSystemScope } from '@winback/db';
import {
  assertRead,
  createTestMerchant,
  getTestClient,
  resetDb,
} from '@winback/db/test-utils';
import type { Job } from 'bullmq';

import type { SchedulerContext } from '../../../scheduler/src/context.js';
import { runDecaySweep } from '../../../scheduler/src/handlers/decay-sweep.js';

import type { DrainerContext } from '../../src/context.js';
import { runDrainTick } from '../../src/drainer.js';
import {
  type AiGenerateJobPayload,
  processAiGenerateJob,
} from '../../src/workers/ai-generate.worker.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHOP = 'harness-lapsed-to-generation.myshopify.com';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Target seed rDays. Phase 1 established `at_risk` at rDays=120 as the
 * safest lapsed band (91-180d range, far from the 365d cohort window
 * edge and the >365d `lost` cliff). Same value here so the target lands
 * in the SAME band Phase 1 asserted; the assertion `rDays === 120` on
 * the resulting `AiGeneration` row also witnesses that the whole
 * pipeline carried the R-value through end-to-end.
 */
const TARGET_R_DAYS = 120;

/**
 * Filler seed rDays — customers that stay `active`, present ONLY to
 * lift the cohort above `INSUFFICIENT_COHORT_THRESHOLD = 5`. With a
 * lone target the whole cohort would route to `insufficient_data` and
 * the sweep's working-set filter would skip the target entirely. Same
 * cohort-threshold catch documented in Phase 1's risk #1.
 */
const FILLER_R_DAYS = 5;

/**
 * Deterministic provider response. Assertion asserts `generatedText`
 * verbatim (`===`) so any change to the pipeline that mangles the text
 * blob (encoding, truncation, over-eager sanitisation) fires loudly.
 */
const MOCK_GENERATED_TEXT = 'test-generated-body';
const MOCK_INPUT_TOKENS = 100;
const MOCK_OUTPUT_TOKENS = 50;
const MOCK_TOTAL_TOKENS = MOCK_INPUT_TOKENS + MOCK_OUTPUT_TOKENS;

// ---------------------------------------------------------------------------
// Clock helper — today@noon UTC per the handoff carry-forward lesson
// ---------------------------------------------------------------------------

/**
 * Today's date at 12:00:00 UTC, computed from the REAL wall clock at
 * call time. Called BEFORE `vi.useFakeTimers()` in `beforeEach`, so the
 * wall clock is real when this runs.
 *
 * Near-real-now pin per PR #123's handoff lesson: this file's seeds use
 * Prisma `@default(now())` (Postgres clock), so pinning JS to a fixed
 * past date would manufacture a JS/Postgres clock gap. Today@noon keeps
 * JS within hours of Postgres.
 */
function noonUtcToday(): Date {
  const nowReal = new Date();
  return new Date(Date.UTC(
    nowReal.getUTCFullYear(),
    nowReal.getUTCMonth(),
    nowReal.getUTCDate(),
    12, 0, 0, 0,
  ));
}

// ---------------------------------------------------------------------------
// Shared harness state
// ---------------------------------------------------------------------------

const prisma = getTestClient();

let merchantId: string;
let targetCustomerId: string;
let fillerCustomerIds: string[];
let queueAdd: ReturnType<typeof vi.fn>;
let mockGenerate: ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Seed helpers — ALL writes through withSystemScope (8.4 Lesson 2 — also
// carried into Phase 1 and reinforced by the tenant-scope Prisma extension)
// ---------------------------------------------------------------------------

async function seedCustomer(shopifyCustomerId: string, firstName: string): Promise<string> {
  return withSystemScope('test.seed_customer', async () => {
    const c = await prisma.customer.create({
      data: {
        merchantId,
        shopifyCustomerId,
        email: `${firstName.toLowerCase()}@example.com`,
        firstName,
        lastName: 'Smith',
        emailMarketingConsentState: 'subscribed',
        // Schema default is `active`; explicit here because the sweep's
        // working-set filter is `state IN (active, warm, at_risk, dormant)`.
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
        financialStatus: 'paid',
        isTest: false,
        placedAt: args.placedAt,
        shopifyProcessedAt: null,
      },
    });
  });
}

/**
 * Full 6-customer cohort: 1 target at rDays=120 (will decay to
 * `at_risk`) + 5 fillers at rDays=5 (stay `active` — cohort-threshold
 * lift only). Identical shape to Phase 1's seed.
 */
async function seedCohort(): Promise<void> {
  targetCustomerId = await seedCustomer('gid://shopify/Customer/target', 'Alice');
  await seedPaidOrder({
    customerId: targetCustomerId,
    shopifyOrderId: 'gid://shopify/Order/target',
    placedAt: new Date(noonUtcToday().getTime() - TARGET_R_DAYS * DAY_MS),
  });

  fillerCustomerIds = [];
  for (let i = 1; i <= 5; i++) {
    const id = await seedCustomer(`gid://shopify/Customer/filler-${String(i)}`, `Filler${String(i)}`);
    fillerCustomerIds.push(id);
    await seedPaidOrder({
      customerId: id,
      shopifyOrderId: `gid://shopify/Order/filler-${String(i)}`,
      placedAt: new Date(noonUtcToday().getTime() - FILLER_R_DAYS * DAY_MS),
    });
  }
}

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

function makeSchedulerCtx(): SchedulerContext {
  // The sweep uses only `ctx.prisma`; the queues + shopifyConfig fields on
  // SchedulerContext are irrelevant to the decay-sweep path.
  return { prisma } as unknown as SchedulerContext;
}

function makeDrainerCtx(): DrainerContext {
  // Handler uses `ctx.prisma` + `ctx.queues.aiGenerate.add`. The
  // dispatch-worker fields (`emailProvider`/`emailFromAddress`/
  // `emailConfigurationSetName`) are irrelevant to the generation path
  // but the type requires them; cast via `unknown` to satisfy TS
  // without inventing stub values that could accidentally be used.
  return {
    prisma,
    queues: {
      aiGenerate: { add: queueAdd } as never,
    } as never,
  } as unknown as DrainerContext;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('LAPSED → GENERATION seam — real Postgres, real drain, mocked LLM provider (harness Phase 2 of 3)', () => {
  beforeEach(async () => {
    await resetDb();

    // Order matters: fake timers active BEFORE `createTestMerchant`
    // (which calls JS `new Date()` for `installedAt` + `scoringInitializedAt`)
    // and BEFORE any seed write below. Seed rows themselves use Prisma
    // `@default(now())` (Postgres clock) so the fake timer does not affect
    // their timestamps; only JS-side `new Date()` calls in the sweep +
    // handler + worker resolve to the pinned instant.
    //
    // `toFake: ['Date']` — ONLY fake the Date global; leave setTimeout /
    // setInterval / setImmediate on real timers. Load-bearing: the
    // rate-limiter's Redis pipeline (ioredis) uses timer paths that
    // would stall under full fake timers; the AI worker's own retries
    // also use real backoff `sleep`s. Date-only faking pins seed +
    // sweep `now` without breaking timer-based paths.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(noonUtcToday());

    // Provider mock reset per test: `selectActiveProvider` is
    // memoised inside `@winback/ai` on the AiConfig reference. A stale
    // return value from a previous test would leak; `mockReset` clears
    // both call history and any previous return value.
    vi.mocked(selectActiveProvider).mockReset();
    mockGenerate = vi.fn(async (_args: AiGenerateArgs) => ({
      content: MOCK_GENERATED_TEXT,
      inputTokens: MOCK_INPUT_TOKENS,
      outputTokens: MOCK_OUTPUT_TOKENS,
      totalTokens: MOCK_TOTAL_TOKENS,
      latencyMs: 12,
    } satisfies AiGenerateResult));
    vi.mocked(selectActiveProvider).mockReturnValue({
      name: 'deepseek',
      generate: mockGenerate,
    } as never);

    // Stub queue: captures the handler's `ctx.queues.aiGenerate.add(...)`
    // call. The BullMQ Worker itself is unit-tested exhaustively; we
    // do NOT spin up real BullMQ here (same Q-I1(β) scope decision as
    // `ai-generate.test.ts`). Extract the captured payload from
    // `queueAdd.mock.calls` post-drain and hand it to
    // `processAiGenerateJob` manually.
    queueAdd = vi.fn(async () => ({ id: 'fake-job-id' }));

    merchantId = await createTestMerchant(SHOP);
    await seedCohort();
  });

  afterEach(() => {
    // Real timers back for the next `beforeEach`'s `noonUtcToday()`.
    vi.useRealTimers();
  });

  it('sweep emits customer.state_changed → drain routes to handler → handler creates AiGeneration+Message → mocked worker completes → Message.generatedText populated with verbatim mock content', async () => {
    // -----------------------------------------------------------------------
    // (1) Run the REAL sweep. This is Phase 1's proven path — chained
    // here so the OutboxEvent is genuinely PRODUCED, not planted.
    // -----------------------------------------------------------------------
    await runDecaySweep(makeSchedulerCtx());

    // Sanity: exactly one `customer.state_changed` OutboxEvent emitted,
    // still unprocessed (nobody has drained yet).
    const outboxBeforeDrain = await assertRead(() =>
      prisma.outboxEvent.findMany({
        where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
      }),
    );
    expect(outboxBeforeDrain).toHaveLength(1);
    expect(outboxBeforeDrain[0]?.processedAt).toBeNull();

    // -----------------------------------------------------------------------
    // (2) Run the REAL drain. `runDrainTick` claims the batch, dispatches
    // via the exhaustive `dispatchEvent` switch, invokes
    // `handleCustomerStateChanged`, marks processed. §5 #1 (the
    // producer/consumer seam) is exercised here — the sweep-persisted
    // payload is parsed by `customerStateChangedPayloadSchema.parse`.
    // -----------------------------------------------------------------------
    const drainerCtx = makeDrainerCtx();
    const drainResult = await runDrainTick(drainerCtx);
    expect(drainResult.claimed).toBeGreaterThanOrEqual(1);

    // Producer/consumer seam PROVEN: the sweep's payload parsed cleanly,
    // the handler ran to completion, the OutboxEvent is marked processed
    // with no lastError. If this assertion fails on `processedAt`,
    // §5 #1 fired — a real bug the harness caught. STOP + surface, do
    // NOT paper over.
    const outboxAfterDrain = await assertRead(() =>
      prisma.outboxEvent.findMany({
        where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
      }),
    );
    expect(outboxAfterDrain).toHaveLength(1);
    expect(outboxAfterDrain[0]?.processedAt).not.toBeNull();
    expect(outboxAfterDrain[0]?.lastError).toBeNull();

    // -----------------------------------------------------------------------
    // (3) Extract the enqueued payload. Handler step 9 enqueues one
    // `ai.generate` job with `jobId = aiGenerationId` (§F-8
    // idempotent-replay contract).
    // -----------------------------------------------------------------------
    expect(queueAdd).toHaveBeenCalledTimes(1);
    const enqueueCall = queueAdd.mock.calls[0];
    expect(enqueueCall).toBeDefined();
    const jobName = enqueueCall?.[0] as string;
    const enqueuedPayload = enqueueCall?.[1] as AiGenerateJobPayload;
    const enqueueOpts = enqueueCall?.[2] as { readonly jobId: string };

    expect(jobName).toBe('generate');
    expect(enqueuedPayload.merchantId).toBe(merchantId);
    expect(enqueuedPayload.customerId).toBe(targetCustomerId);
    expect(typeof enqueuedPayload.aiGenerationId).toBe('string');
    expect(enqueuedPayload.aiGenerationId.length).toBeGreaterThan(0);
    // §F-8 lock — jobId = aiGenerationId enforces BullMQ-level dedup on
    // any accidental re-enqueue of the same generation.
    expect(enqueueOpts.jobId).toBe(enqueuedPayload.aiGenerationId);

    // -----------------------------------------------------------------------
    // (4) Invoke the REAL worker with the captured payload. Direct
    // invocation, mirroring `ai-generate.test.ts`'s Q-I1(β) posture.
    // -----------------------------------------------------------------------
    await processAiGenerateJob(drainerCtx, {
      id: enqueuedPayload.aiGenerationId,
      data: enqueuedPayload,
      attemptsMade: 0,
    } as unknown as Job<AiGenerateJobPayload>);

    // -----------------------------------------------------------------------
    // (5) ASSERTIONS — the §4 set.
    // -----------------------------------------------------------------------

    // (5a) AiGeneration completed — verbatim generatedText, rDays 120
    // carried through from Phase 1's seed, provider/model from CI env.
    const aiGen = await assertRead(() =>
      prisma.aiGeneration.findUnique({
        where: { id: enqueuedPayload.aiGenerationId },
      }),
    );
    expect(aiGen).not.toBeNull();
    expect(aiGen?.status).toBe('completed');
    expect(aiGen?.generatedText).toBe(MOCK_GENERATED_TEXT);
    expect(aiGen?.provider).toBe('deepseek');
    expect(aiGen?.modelId).toBe('deepseek-v4-flash');
    expect(aiGen?.triggerState).toBe('at_risk');
    expect(aiGen?.previousState).toBe('active');
    expect(aiGen?.rDays).toBe(TARGET_R_DAYS); // 120 — STRICT, carried through
    expect(aiGen?.inputTokens).toBe(MOCK_INPUT_TOKENS);
    expect(aiGen?.outputTokens).toBe(MOCK_OUTPUT_TOKENS);
    expect(aiGen?.totalTokens).toBe(MOCK_TOTAL_TOKENS);
    expect(aiGen?.completedAt).not.toBeNull();
    expect(aiGen?.lastError).toBeNull();
    expect(aiGen?.failedAt).toBeNull();

    // (5b) Message draft — status stays `draft` (Phase 3 flips to `sent`);
    // generatedText denormalized via worker's `updateGeneratedText`;
    // links back to the AiGeneration.
    const message = await assertRead(() =>
      prisma.message.findFirst({
        where: {
          customerId: targetCustomerId,
          aiGenerationId: enqueuedPayload.aiGenerationId,
        },
      }),
    );
    expect(message).not.toBeNull();
    expect(message?.status).toBe('draft');
    expect(message?.generatedText).toBe(MOCK_GENERATED_TEXT);
    expect(message?.aiGenerationId).toBe(enqueuedPayload.aiGenerationId);

    // (5c) AiSpendBucket — exactly one row for this merchant (single
    // daily bucket for today), positive spent + one generation
    // recorded. Buckets are per-day UTC; the handler's spend-cap check
    // sums across the current month.
    const buckets = await assertRead(() =>
      prisma.aiSpendBucket.findMany({ where: { merchantId } }),
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.spentMicrocents).toBeGreaterThan(0n);
    expect(buckets[0]?.generationCount).toBe(1);

    // (5d) No rate-limit / spend-cap audit rows — the handler didn't bail.
    const rateAudits = await assertRead(() =>
      prisma.auditLog.count({
        where: { merchantId, action: AUDIT_ACTIONS.ai.rate_limited },
      }),
    );
    expect(rateAudits).toBe(0);
    const spendCapAudits = await assertRead(() =>
      prisma.auditLog.count({
        where: { merchantId, action: AUDIT_ACTIONS.ai.spend_cap_exceeded },
      }),
    );
    expect(spendCapAudits).toBe(0);

    // (5e) Fillers unchanged — no AiGeneration, no Message. Fillers
    // never emitted a state_changed event (their `active → active`
    // stayed put in Phase 1's proof); this asserts the drain path
    // didn't spuriously fan out to them.
    const fillerGens = await assertRead(() =>
      prisma.aiGeneration.count({
        where: { merchantId, customerId: { in: fillerCustomerIds } },
      }),
    );
    expect(fillerGens).toBe(0);
    const fillerMessages = await assertRead(() =>
      prisma.message.count({
        where: { merchantId, customerId: { in: fillerCustomerIds } },
      }),
    );
    expect(fillerMessages).toBe(0);

    // (5f) Provider called exactly once — the seam produced ONE
    // generation, not zero and not two.
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });
});
