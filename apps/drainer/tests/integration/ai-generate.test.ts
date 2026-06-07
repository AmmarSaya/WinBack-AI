/**
 * Epic F batch 5 — end-to-end integration suite for AI generation
 * (§F-9 handler + §F-8 worker, real Postgres, mocked LLM provider).
 *
 * Closes Epic F by verifying the DB-side invariants that unit tests
 * (mocked Prisma) can't observe:
 *   - Prisma extension's tenant-scope injection on every read/write
 *   - schema-level FK CASCADE chain on Customer hard-delete (GDPR)
 *   - Postgres unique-index row-lock atomicity for incrementSpend under
 *     parallel callers
 *   - the §F-Q7 3-write atomicity property when all writes hit real Postgres
 *   - the race-replay guard's data-side outcome under a real concurrent
 *     update against the AiGeneration row
 *
 * Scope decisions (Phase 1 audit, locked):
 *   - Q-I1 (β): direct `processAiGenerateJob` invocation — no real
 *     BullMQ flow in integration. Handler enqueues to a stubbed Queue
 *     that captures the payload; test invokes the worker manually with
 *     the captured payload. BullMQ-specific behavior (jobId idempotency,
 *     attempts:3, exponential backoff) is unit-tested exhaustively.
 *   - Q-I2 (β): concurrency scenario uses `Promise.all` parallel
 *     `processAiGenerateJob` calls against real Postgres — exercises
 *     the actual unique-index row-lock that's the load-bearing
 *     atomicity property.
 *   - Q-I3: Queue stub = `{ add: vi.fn(async () => ({ id: 'fake-job-id' })) }`.
 *     Test reads `queueAdd.mock.calls[0]` to extract the payload.
 *   - Q-I4: race-replay simulated via direct `prisma.aiGeneration.update`
 *     SIDE-EFFECT inside the mocked `provider.generate` (Option B per
 *     Step 5b clarification — exercises the actual `markCompleted
 *     updatedCount=0` guard, NOT the pickup guard).
 *   - Q-I6: no MessageStatus enum work.
 *
 * The LLM provider is mocked via `vi.mock('@winback/ai', ...)` — same
 * pattern as the unit tests (`apps/drainer/tests/workers/ai-generate.
 * worker.test.ts:62`). `selectActiveProvider` is replaced with a stub
 * controllable per-test via `setProviderGenerate`; `getAiConfig`,
 * `estimateCostMicrocents`, and the typed error classes pass through
 * (real implementations exercised).
 *
 * `@winback/shopify` is mocked the same way for `fetchRecentOrders` so
 * the integration harness never reaches Shopify (the handler swallows
 * fetch failures + falls back to empty list, but mocking eliminates
 * the network attempt entirely).
 */

import { describe, it, expect, vi, beforeEach, afterAll, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must hoist above the static imports below
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
    fetchRecentOrders: vi.fn(async () => []),
  };
});

// ---------------------------------------------------------------------------
// Imports — AFTER mocks
// ---------------------------------------------------------------------------

import {
  AiProviderAuthError,
  AiProviderContentBlockedError,
  type AiGenerateArgs,
  type AiGenerateResult,
  selectActiveProvider,
} from '@winback/ai';
import { AUDIT_ACTIONS } from '@winback/contracts';
import {
  type OutboxEventRow,
  type WinbackPrisma,
  withSystemScope,
} from '@winback/db';
import {
  createTestMerchant,
  getTestClient,
  resetDb,
  assertRead,
} from '@winback/db/test-utils';
import type { Queues } from '@winback/queue';
import type { ShopifyConfig } from '@winback/shopify';
import type { Job } from 'bullmq';

import type { DrainerContext } from '../../src/context.js';
import { handleCustomerStateChanged } from '../../src/handlers/customer-state-changed.js';
import {
  type AiGenerateJobPayload,
  processAiGenerateJob,
} from '../../src/workers/ai-generate.worker.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SHOP = 'epic-f-integration.myshopify.com';

interface MakeCtxResult {
  ctx: DrainerContext;
  queueAdd: Mock;
}

function makeAiCtx(): MakeCtxResult {
  // Queue stub — the handler's `ctx.queues.aiGenerate.add(...)` call
  // resolves against this. The Mock instance captures the call args
  // (jobName, payload, opts) so the test can extract the payload + opts
  // for the worker invocation.
  const queueAdd = vi.fn(
    async (_jobName: string, _payload: unknown, _opts: unknown) => ({
      id: 'fake-job-id',
    }),
  );

  const ctx: DrainerContext = {
    prisma: getTestClient(),
    queues: {
      aiGenerate: { add: queueAdd } as never,
      outboxDrain: {} as never,
      cronRollup: {} as never,
      cronSweep: {} as never,
    },
    shopifyConfig: {} as unknown as ShopifyConfig,
  };

  return { ctx, queueAdd };
}

interface HappyResultOverrides {
  content?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
}

function happyResult(overrides: HappyResultOverrides = {}): AiGenerateResult {
  const inputTokens = overrides.inputTokens ?? 200;
  const outputTokens = overrides.outputTokens ?? 100;
  return {
    content: overrides.content ?? 'Hey Alice, we miss you!',
    inputTokens,
    outputTokens,
    totalTokens: overrides.totalTokens ?? inputTokens + outputTokens,
    latencyMs: overrides.latencyMs ?? 412,
  };
}

/**
 * Cost for the standard happyResult() token counts under DeepSeek
 * v4-flash rates: 200 input × 14_000_000 microcents/1M + 100 output ×
 * 28_000_000 microcents/1M = 2_800 + 2_800 = 5_600 microcents
 * ($0.000056). Anchored so the scenario-1 assertion is legible.
 */
const HAPPY_RESULT_COST_MICROCENTS = 5_600n;

/**
 * Configure `selectActiveProvider` to return a stub provider whose
 * generate fn invokes `impl`. Returns the Mock for introspection.
 */
function setProviderGenerate(
  impl: (args: AiGenerateArgs) => Promise<AiGenerateResult>,
): Mock {
  const generate = vi.fn(impl as never);
  vi.mocked(selectActiveProvider).mockReturnValue({
    name: 'deepseek',
    generate,
  } as never);
  return generate;
}

/**
 * Seeds a Customer row with firstName/lastName set so
 * `buildWinbackPrompt` produces a realistic user prompt (not a
 * fallback "valued customer" salutation). Returns the local cuid.
 */
async function seedCustomer(
  merchantId: string,
  shopifyCustomerId: string,
  firstName = 'Alice',
): Promise<string> {
  return withSystemScope('test.setup_customer', async () => {
    const c = await getTestClient().customer.create({
      data: {
        merchantId,
        shopifyCustomerId,
        firstName,
        lastName: 'Smith',
        email: `${firstName.toLowerCase()}@example.com`,
      },
      select: { id: true },
    });
    return c.id;
  });
}

/**
 * Build a `customer.state_changed` OutboxEventRow matching the
 * producer shape Epic E session 2's scoring service writes. Used to
 * drive `handleCustomerStateChanged` directly (no drainer-tick loop
 * needed; that's tested separately in drainer-tick.test.ts).
 */
function makeStateChangedRow(args: {
  merchantId: string;
  customerId: string;
  shopifyCustomerId: string;
  eventId?: string;
  oldState?: string;
  newState?: string;
  rDays?: number;
  fCount?: number;
  mCents?: string;
}): OutboxEventRow {
  return {
    id: args.eventId ?? `evt-${Math.random().toString(36).slice(2, 10)}`,
    merchantId: args.merchantId,
    type: 'customer.state_changed',
    payload: {
      merchantId: args.merchantId,
      customerId: args.customerId,
      shopifyCustomerId: args.shopifyCustomerId,
      oldState: args.oldState ?? 'active',
      newState: args.newState ?? 'at_risk',
      computedAt: new Date().toISOString(),
      rfmScore: {
        rDays: args.rDays ?? 45,
        fCount: args.fCount ?? 3,
        mCents: args.mCents ?? '12500',
        rQuintile: 2,
        fQuintile: 3,
        mQuintile: 3,
      },
    },
    attempts: 0,
    createdAt: new Date(),
  } as unknown as OutboxEventRow;
}

/**
 * Extract `(jobName, payload, opts)` from the queue stub's nth call,
 * with the payload narrowed to the expected shape.
 */
function captureQueuePayload(
  queueAdd: Mock,
  callIndex = 0,
): { jobName: string; payload: AiGenerateJobPayload; opts: { jobId: string } } {
  const call = queueAdd.mock.calls[callIndex];
  expect(call).toBeDefined();
  return {
    jobName: call![0] as string,
    payload: call![1] as AiGenerateJobPayload,
    opts: call![2] as { jobId: string },
  };
}

/**
 * Invoke `processAiGenerateJob` with a synthetic Job<> shape carrying
 * the captured payload. Mirrors the unit-test pattern at
 * `apps/drainer/tests/workers/ai-generate.worker.test.ts:226`.
 */
async function runWorkerForPayload(
  ctx: DrainerContext,
  payload: AiGenerateJobPayload,
  options: { attemptsMade?: number } = {},
): Promise<void> {
  const job = {
    id: payload.aiGenerationId,
    data: payload,
    attemptsMade: options.attemptsMade ?? 0,
  } as unknown as Job<AiGenerateJobPayload>;
  await processAiGenerateJob(ctx, job);
}

/**
 * Reset cached provider memoisation between tests so each test gets a
 * fresh `selectActiveProvider` invocation that picks up the
 * `mockReturnValue` set by `setProviderGenerate`. (Without this the
 * memoisation in packages/ai/src/providers/index.ts could return a
 * stale provider across tests.)
 */
function resetProviderMock(): void {
  vi.mocked(selectActiveProvider).mockReset();
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Epic F end-to-end integration (real Postgres, mocked LLM provider)', () => {
  beforeEach(async () => {
    await resetDb();
    resetProviderMock();
  });

  afterAll(async () => {
    await getTestClient().$disconnect();
  });

  // -------------------------------------------------------------------------
  // Scenario 1 — happy path end-to-end
  // -------------------------------------------------------------------------

  it('1. happy path: handler creates AiGeneration + Message → worker completes 3-write tx → spend bucket incremented', async () => {
    const merchantId = await createTestMerchant(SHOP);
    const shopifyCustomerId = 'gid://shopify/Customer/300001';
    const customerId = await seedCustomer(merchantId, shopifyCustomerId);

    const { ctx, queueAdd } = makeAiCtx();
    const generate = setProviderGenerate(async () => happyResult());

    const row = makeStateChangedRow({ merchantId, customerId, shopifyCustomerId });

    // Handler invocation (pre-LLM phase): creates pending AiGeneration
    // + draft Message in one tx, enqueues to the stub.
    await handleCustomerStateChanged(ctx, row);

    // Queue captured exactly one job — extract for worker invocation.
    expect(queueAdd).toHaveBeenCalledTimes(1);
    const captured = captureQueuePayload(queueAdd);
    expect(captured.jobName).toBe('generate');
    expect(captured.payload.merchantId).toBe(merchantId);
    expect(captured.payload.customerId).toBe(customerId);
    expect(captured.opts.jobId).toBe(captured.payload.aiGenerationId);

    // Worker invocation (post-LLM phase): provider returns happyResult,
    // 3-write completion tx commits.
    await runWorkerForPayload(ctx, captured.payload);

    // ── AiGeneration assertions ─────────────────────────────────────────
    const aiGen = await assertRead(() =>
      getTestClient().aiGeneration.findUnique({
        where: { id: captured.payload.aiGenerationId },
      }),
    );
    expect(aiGen).not.toBeNull();
    expect(aiGen!.status).toBe('completed');
    expect(aiGen!.generatedText).toBe('Hey Alice, we miss you!');
    expect(aiGen!.inputTokens).toBe(200);
    expect(aiGen!.outputTokens).toBe(100);
    expect(aiGen!.totalTokens).toBe(300);
    expect(aiGen!.latencyMs).toBe(412);
    // Cost matches estimateCostMicrocents(deepseek, deepseek-v4-flash,
    // 200, 100) = 200×14_000_000/1M + 100×28_000_000/1M = 5_600 microcents.
    // BigInt round-trip through Postgres BigInt column preserved.
    expect(aiGen!.costMicrocents).toBe(HAPPY_RESULT_COST_MICROCENTS);
    expect(aiGen!.completedAt).toBeInstanceOf(Date);
    expect(aiGen!.failedAt).toBeNull();
    expect(aiGen!.lastError).toBeNull();
    // Trigger snapshot fields from the row payload.
    expect(aiGen!.triggerState).toBe('at_risk');
    expect(aiGen!.previousState).toBe('active');
    expect(aiGen!.provider).toBe('deepseek');
    expect(aiGen!.modelId).toBe('deepseek-v4-flash');

    // ── Message assertions ──────────────────────────────────────────────
    const message = await assertRead(() =>
      getTestClient().message.findUnique({
        where: { aiGenerationId: captured.payload.aiGenerationId },
      }),
    );
    expect(message).not.toBeNull();
    expect(message!.status).toBe('draft'); // Epic G transitions later
    expect(message!.generatedText).toBe('Hey Alice, we miss you!');
    expect(message!.aiGenerationId).toBe(captured.payload.aiGenerationId);
    expect(message!.merchantId).toBe(merchantId);
    expect(message!.customerId).toBe(customerId);

    // ── AiSpendBucket assertions ────────────────────────────────────────
    const buckets = await assertRead(() =>
      getTestClient().aiSpendBucket.findMany({ where: { merchantId } }),
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.spentMicrocents).toBe(HAPPY_RESULT_COST_MICROCENTS);
    expect(buckets[0]!.generationCount).toBe(1);

    // ── Provider was called exactly once with the prompts stored on the
    //    AiGeneration row (locks: worker reads STORED prompts, doesn't
    //    rebuild via buildWinbackPrompt).
    expect(generate).toHaveBeenCalledTimes(1);
    const generateArgs = generate.mock.calls[0]![0] as AiGenerateArgs;
    expect(generateArgs.model).toBe('deepseek-v4-flash');
    expect(generateArgs.systemPrompt).toBe(aiGen!.systemPrompt);
    expect(generateArgs.userPrompt).toBe(aiGen!.userPrompt);
    expect(generateArgs.maxTokens).toBe(300);
    expect(generateArgs.temperature).toBe(0.7);
  });

  // -------------------------------------------------------------------------
  // Scenario 2 — spend ceiling exceeded
  // -------------------------------------------------------------------------

  it('2. spend ceiling exceeded: handler writes ai.spend_cap_exceeded audit + NO AiGeneration / Message / queue enqueue', async () => {
    const merchantId = await createTestMerchant(SHOP);
    const shopifyCustomerId = 'gid://shopify/Customer/400001';
    const customerId = await seedCustomer(merchantId, shopifyCustomerId);

    // Cap is the schema default: 50_000n cents → 5_000_000_000n microcents
    // ($500/mo). Pre-seed today's bucket at cap - 1n microcent so any
    // call's estimated cost pushes the sum over.
    //
    // capMicrocents       = 50_000 × 100_000 = 5_000_000_000n
    // pre-seeded spend    = 4_999_999_999n
    // estimated call cost = 500 input × 14_000_000/1M + 300 output ×
    //                       28_000_000/1M = 7_000 + 8_400 = 15_400 microcents
    //                       (handler uses worst-case AI_MAX_TOKENS=300 for
    //                       the ceiling check, NOT the actual token counts
    //                       from a provider response).
    // sum                 = 4_999_999_999 + 15_400 = 5_000_015_399n > cap
    const CAP_MICROCENTS = 5_000_000_000n;
    const PRESEEDED_SPEND = 4_999_999_999n;
    const ESTIMATED_CALL_MICROCENTS = 15_400n;

    const utcMidnight = new Date(
      Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        new Date().getUTCDate(),
      ),
    );
    await withSystemScope('test.seed_spend_bucket', async () => {
      await getTestClient().aiSpendBucket.create({
        data: {
          merchantId,
          date: utcMidnight,
          spentMicrocents: PRESEEDED_SPEND,
          generationCount: 99,
        },
      });
    });

    const { ctx, queueAdd } = makeAiCtx();
    // Provider should NEVER be called — bind a generate that throws if
    // somehow invoked, so a regression would fail loudly here rather
    // than passing for the wrong reason.
    setProviderGenerate(async () => {
      throw new Error('provider.generate should not be called when spend cap is exceeded');
    });

    const eventId = `evt-spend-cap-${Math.random().toString(36).slice(2, 10)}`;
    const row = makeStateChangedRow({
      merchantId,
      customerId,
      shopifyCustomerId,
      eventId,
    });

    await handleCustomerStateChanged(ctx, row);

    // ── NO AiGeneration row ─────────────────────────────────────────────
    const aiGenCount = await assertRead(() =>
      getTestClient().aiGeneration.count({ where: { merchantId } }),
    );
    expect(aiGenCount).toBe(0);

    // ── NO Message row ──────────────────────────────────────────────────
    const messageCount = await assertRead(() =>
      getTestClient().message.count({ where: { merchantId } }),
    );
    expect(messageCount).toBe(0);

    // ── NO queue enqueue ────────────────────────────────────────────────
    expect(queueAdd).not.toHaveBeenCalled();

    // ── AuditLog row written with stringified BigInts ───────────────────
    const audits = await assertRead(() =>
      getTestClient().auditLog.findMany({
        where: { merchantId, action: AUDIT_ACTIONS.ai.spend_cap_exceeded },
      }),
    );
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.actorType).toBe('system');
    expect(audit.actorId).toBe('drainer');
    expect(audit.targetType).toBe('customer');
    expect(audit.targetId).toBe(customerId);
    expect(audit.shop).toBe(SHOP);

    const context = audit.context as Record<string, unknown>;
    expect(context).toMatchObject({
      // Stringified BigInts per rule #19 (JSON serialisation boundary).
      currentSpendMicrocents: PRESEEDED_SPEND.toString(),
      capMicrocents: CAP_MICROCENTS.toString(),
      estimatedCallMicrocents: ESTIMATED_CALL_MICROCENTS.toString(),
      monthlyAiSpendCapCents: '50000', // schema default, stringified
      eventId,
    });

    // ── Spend bucket unchanged (no incrementSpend ran) ──────────────────
    const buckets = await assertRead(() =>
      getTestClient().aiSpendBucket.findMany({ where: { merchantId } }),
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.spentMicrocents).toBe(PRESEEDED_SPEND); // untouched
    expect(buckets[0]!.generationCount).toBe(99); // untouched
  });

  // -------------------------------------------------------------------------
  // Scenario 3 — concurrent jobs serialized via unique-index row-lock
  // -------------------------------------------------------------------------

  it('3. concurrent workers (Promise.all) on same merchant/day: both AiGenerations completed + spend bucket = sum (no lost update)', async () => {
    const merchantId = await createTestMerchant(SHOP);
    const customerIdA = await seedCustomer(
      merchantId,
      'gid://shopify/Customer/500001',
      'Alice',
    );
    const customerIdB = await seedCustomer(
      merchantId,
      'gid://shopify/Customer/500002',
      'Bob',
    );

    const { ctx, queueAdd } = makeAiCtx();
    setProviderGenerate(async () => happyResult());

    // Two handler invocations (sequential) → 2 AiGeneration rows
    // pending, 2 captured queue payloads.
    await handleCustomerStateChanged(
      ctx,
      makeStateChangedRow({
        merchantId,
        customerId: customerIdA,
        shopifyCustomerId: 'gid://shopify/Customer/500001',
      }),
    );
    await handleCustomerStateChanged(
      ctx,
      makeStateChangedRow({
        merchantId,
        customerId: customerIdB,
        shopifyCustomerId: 'gid://shopify/Customer/500002',
      }),
    );
    expect(queueAdd).toHaveBeenCalledTimes(2);
    const capturedA = captureQueuePayload(queueAdd, 0);
    const capturedB = captureQueuePayload(queueAdd, 1);

    // ── THE CRITICAL TEST ────────────────────────────────────────────────
    // Two workers run in PARALLEL against the SAME merchant/day bucket.
    // The upsert's INSERT ... ON CONFLICT DO UPDATE acquires the row-
    // level X-lock on the @@unique([merchantId, date]) index — Postgres
    // serializes the two UPDATE paths. If a lost-update bug existed (e.g.
    // read-then-write without locking), spentMicrocents would equal ONE
    // cost instead of TWO. This is exactly the property that's hard to
    // prove at unit level (mocked Prisma can't reproduce real DB
    // serialization) and is the load-bearing concurrency invariant for
    // the AiSpendBucket pattern Epic G will copy.
    await Promise.all([
      runWorkerForPayload(ctx, capturedA.payload),
      runWorkerForPayload(ctx, capturedB.payload),
    ]);

    // ── Both AiGenerations completed ────────────────────────────────────
    const aiGens = await assertRead(() =>
      getTestClient().aiGeneration.findMany({
        where: { merchantId },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(aiGens).toHaveLength(2);
    expect(aiGens[0]!.status).toBe('completed');
    expect(aiGens[1]!.status).toBe('completed');

    // ── Spend bucket = sum of both costs (LOST-UPDATE LOCK) ─────────────
    const buckets = await assertRead(() =>
      getTestClient().aiSpendBucket.findMany({ where: { merchantId } }),
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.spentMicrocents).toBe(HAPPY_RESULT_COST_MICROCENTS * 2n);
    expect(buckets[0]!.generationCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Scenario 4 — GDPR cascade chain
  // -------------------------------------------------------------------------

  it('4. GDPR cascade: Customer hard-delete → AiGeneration + Message cascaded; AiSpendBucket preserved', async () => {
    const merchantId = await createTestMerchant(SHOP);
    const shopifyCustomerId = 'gid://shopify/Customer/600001';
    const customerId = await seedCustomer(merchantId, shopifyCustomerId);

    const { ctx, queueAdd } = makeAiCtx();
    setProviderGenerate(async () => happyResult());

    // Run a happy-path pipeline first to populate AiGeneration + Message
    // + AiSpendBucket. Then simulate the GDPR cascade by hard-deleting
    // the Customer row directly (note: production processCustomerRedact
    // soft-deletes via deletedAt; this test exercises the schema's FK
    // CASCADE chain, which is the property §F-12 of EPIC-F-DESIGN.md
    // documents and which gdpr.shop_redacted's Merchant hard-delete
    // will rely on transitively).
    await handleCustomerStateChanged(
      ctx,
      makeStateChangedRow({ merchantId, customerId, shopifyCustomerId }),
    );
    const captured = captureQueuePayload(queueAdd);
    await runWorkerForPayload(ctx, captured.payload);

    // Pre-state sanity check.
    const preAiGen = await assertRead(() =>
      getTestClient().aiGeneration.count({ where: { merchantId } }),
    );
    const preMessage = await assertRead(() =>
      getTestClient().message.count({ where: { merchantId } }),
    );
    const preBucket = await assertRead(() =>
      getTestClient().aiSpendBucket.count({ where: { merchantId } }),
    );
    expect(preAiGen).toBe(1);
    expect(preMessage).toBe(1);
    expect(preBucket).toBe(1);

    // ── THE CASCADE TRIGGER ─────────────────────────────────────────────
    // Hard-delete the Customer row under system scope. The soft-delete
    // Prisma extension only filters READS — DELETE passes through to
    // Postgres which fires the schema-declared FK CASCADE chain.
    await withSystemScope('test.gdpr_cascade', async () => {
      await getTestClient().customer.deleteMany({ where: { id: customerId } });
    });

    // ── AiGeneration gone (FK Customer → AiGeneration CASCADE) ──────────
    const postAiGen = await assertRead(() =>
      getTestClient().aiGeneration.count({ where: { merchantId } }),
    );
    expect(postAiGen).toBe(0);

    // ── Message gone (FK Customer → Message CASCADE, also covered
    //    transitively via FK AiGeneration → Message CASCADE) ──────────
    const postMessage = await assertRead(() =>
      getTestClient().message.count({ where: { merchantId } }),
    );
    expect(postMessage).toBe(0);

    // ── AiSpendBucket PRESERVED (no Customer FK by design — spend ledger
    //    is platform accounting, not customer PII) ─────────────────────
    const postBucket = await assertRead(() =>
      getTestClient().aiSpendBucket.findMany({ where: { merchantId } }),
    );
    expect(postBucket).toHaveLength(1);
    expect(postBucket[0]!.spentMicrocents).toBe(HAPPY_RESULT_COST_MICROCENTS);
    expect(postBucket[0]!.generationCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Scenario 5a — non-retryable AiProviderContentBlockedError
  // -------------------------------------------------------------------------

  it('5a. AiProviderContentBlockedError → markFailed(lastError="content_blocked") + ai.content_blocked audit; spend NOT incremented', async () => {
    const merchantId = await createTestMerchant(SHOP);
    const shopifyCustomerId = 'gid://shopify/Customer/700001';
    const customerId = await seedCustomer(merchantId, shopifyCustomerId);

    const { ctx, queueAdd } = makeAiCtx();
    setProviderGenerate(async () => {
      throw new AiProviderContentBlockedError('integration: moderation flagged');
    });

    await handleCustomerStateChanged(
      ctx,
      makeStateChangedRow({ merchantId, customerId, shopifyCustomerId }),
    );
    const captured = captureQueuePayload(queueAdd);
    await runWorkerForPayload(ctx, captured.payload, { attemptsMade: 1 });

    // ── AiGeneration: failed, lastError="content_blocked", failedAt set
    const aiGen = await assertRead(() =>
      getTestClient().aiGeneration.findUnique({
        where: { id: captured.payload.aiGenerationId },
      }),
    );
    expect(aiGen).not.toBeNull();
    expect(aiGen!.status).toBe('failed');
    expect(aiGen!.lastError).toBe('content_blocked');
    expect(aiGen!.failedAt).toBeInstanceOf(Date);
    // Pre-completion fields stay null — no LLM response landed.
    expect(aiGen!.generatedText).toBeNull();
    expect(aiGen!.costMicrocents).toBeNull();
    expect(aiGen!.completedAt).toBeNull();

    // ── AuditLog: ai.content_blocked with Q-A3 context shape ────────────
    const audits = await assertRead(() =>
      getTestClient().auditLog.findMany({
        where: { merchantId, action: AUDIT_ACTIONS.ai.content_blocked },
      }),
    );
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.actorType).toBe('system');
    expect(audit.actorId).toBe('drainer');
    expect(audit.targetType).toBe('ai_generation');
    expect(audit.targetId).toBe(captured.payload.aiGenerationId);
    expect(audit.shop).toBe(SHOP);

    const context = audit.context as Record<string, unknown>;
    expect(context).toMatchObject({
      providerErrorCode: 'content_blocked',
      jobId: captured.payload.aiGenerationId,
      attempt: 1,
      errorMessage: 'integration: moderation flagged',
    });

    // ── No `ai.generation_failed` audit (separate discriminant) ─────────
    const wrongActionAudits = await assertRead(() =>
      getTestClient().auditLog.findMany({
        where: { merchantId, action: AUDIT_ACTIONS.ai.generation_failed },
      }),
    );
    expect(wrongActionAudits).toHaveLength(0);

    // ── Spend bucket: not created (no incrementSpend ran) ───────────────
    const buckets = await assertRead(() =>
      getTestClient().aiSpendBucket.findMany({ where: { merchantId } }),
    );
    expect(buckets).toHaveLength(0);

    // ── Message: still draft with empty generatedText (worker error
    //    path skipped updateGeneratedText) ─────────────────────────────
    const message = await assertRead(() =>
      getTestClient().message.findUnique({
        where: { aiGenerationId: captured.payload.aiGenerationId },
      }),
    );
    expect(message).not.toBeNull();
    expect(message!.status).toBe('draft');
    expect(message!.generatedText).toBe('');
  });

  // -------------------------------------------------------------------------
  // Scenario 5b — non-retryable AiProviderAuthError
  // -------------------------------------------------------------------------

  it('5b. AiProviderAuthError → markFailed(lastError="auth") + ai.generation_failed audit; spend NOT incremented', async () => {
    const merchantId = await createTestMerchant(SHOP);
    const shopifyCustomerId = 'gid://shopify/Customer/800001';
    const customerId = await seedCustomer(merchantId, shopifyCustomerId);

    const { ctx, queueAdd } = makeAiCtx();
    setProviderGenerate(async () => {
      throw new AiProviderAuthError('integration: 401 invalid api key');
    });

    await handleCustomerStateChanged(
      ctx,
      makeStateChangedRow({ merchantId, customerId, shopifyCustomerId }),
    );
    const captured = captureQueuePayload(queueAdd);
    await runWorkerForPayload(ctx, captured.payload, { attemptsMade: 0 });

    // ── AiGeneration: failed, lastError="auth" ──────────────────────────
    const aiGen = await assertRead(() =>
      getTestClient().aiGeneration.findUnique({
        where: { id: captured.payload.aiGenerationId },
      }),
    );
    expect(aiGen).not.toBeNull();
    expect(aiGen!.status).toBe('failed');
    expect(aiGen!.lastError).toBe('auth');
    expect(aiGen!.failedAt).toBeInstanceOf(Date);

    // ── AuditLog: ai.generation_failed (NOT ai.content_blocked) ─────────
    const failedAudits = await assertRead(() =>
      getTestClient().auditLog.findMany({
        where: { merchantId, action: AUDIT_ACTIONS.ai.generation_failed },
      }),
    );
    expect(failedAudits).toHaveLength(1);
    const audit = failedAudits[0]!;
    const context = audit.context as Record<string, unknown>;
    expect(context).toMatchObject({
      providerErrorCode: 'auth',
      jobId: captured.payload.aiGenerationId,
      attempt: 0,
      errorMessage: 'integration: 401 invalid api key',
    });

    const blockedAudits = await assertRead(() =>
      getTestClient().auditLog.findMany({
        where: { merchantId, action: AUDIT_ACTIONS.ai.content_blocked },
      }),
    );
    expect(blockedAudits).toHaveLength(0);

    // ── Spend bucket: not created ───────────────────────────────────────
    const buckets = await assertRead(() =>
      getTestClient().aiSpendBucket.findMany({ where: { merchantId } }),
    );
    expect(buckets).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 6 — race-replay (markCompleted updatedCount=0 guard)
  // -------------------------------------------------------------------------

  it('6. race-replay: markCompleted updatedCount=0 (status flipped DURING provider.generate) → updateGeneratedText + incrementSpend skipped', async () => {
    const merchantId = await createTestMerchant(SHOP);
    const shopifyCustomerId = 'gid://shopify/Customer/900001';
    const customerId = await seedCustomer(merchantId, shopifyCustomerId);

    const { ctx, queueAdd } = makeAiCtx();

    // Handler runs first → AiGeneration created (status='pending') +
    // Message draft + queue payload captured.
    await handleCustomerStateChanged(
      ctx,
      makeStateChangedRow({ merchantId, customerId, shopifyCustomerId }),
    );
    const captured = captureQueuePayload(queueAdd);
    const aiGenerationId = captured.payload.aiGenerationId;

    // ── RACE INJECTION POINT ────────────────────────────────────────────
    // The race-replay guard fires when `markCompleted`'s updateMany
    // WHERE status='pending' matches 0 rows — meaning another worker
    // (or BullMQ stalled-job re-pickup) completed the row between this
    // worker's pickup-read (which saw 'pending') and its tx-open.
    //
    // To reproduce that timing window deterministically: inject the
    // status flip as a SIDE EFFECT inside the mocked provider.generate.
    // Worker timeline:
    //   1. pickup findUnique  → status='pending'        (proceeds)
    //   2. provider.generate  → flips status='completed' externally
    //                           → returns happy result
    //   3. opens prisma.$transaction
    //   4. markCompleted      → WHERE status='pending' → 0 rows
    //   5. race-replay guard fires → skip updateGeneratedText +
    //      incrementSpend; tx commits clean
    setProviderGenerate(async () => {
      // The race: another worker "completes" this row externally,
      // BEFORE our worker's tx opens. We write minimal fields — only
      // status='completed' is load-bearing for the guard.
      await withSystemScope('test.simulate_race_replay', async () => {
        await getTestClient().aiGeneration.update({
          where: { id: aiGenerationId },
          data: {
            status: 'completed',
            generatedText: 'racing-worker-content',
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            latencyMs: 1,
            costMicrocents: 1n,
            completedAt: new Date(),
          },
        });
      });
      return happyResult();
    });

    // Worker invocation — should NOT throw despite the race.
    await runWorkerForPayload(ctx, captured.payload);

    // ── AiGeneration row reflects the EXTERNAL completion (not this
    //    worker's would-be writes — the race-replay guard prevented
    //    them) ────────────────────────────────────────────────────────
    const aiGen = await assertRead(() =>
      getTestClient().aiGeneration.findUnique({ where: { id: aiGenerationId } }),
    );
    expect(aiGen).not.toBeNull();
    expect(aiGen!.status).toBe('completed');
    expect(aiGen!.generatedText).toBe('racing-worker-content'); // racing worker's value, NOT happyResult's
    expect(aiGen!.costMicrocents).toBe(1n);                     // racing worker's value

    // ── Message.generatedText still EMPTY (updateGeneratedText
    //    skipped by the race-replay guard) ─────────────────────────────
    const message = await assertRead(() =>
      getTestClient().message.findUnique({ where: { aiGenerationId } }),
    );
    expect(message).not.toBeNull();
    expect(message!.generatedText).toBe('');

    // ── AiSpendBucket NOT created/incremented (incrementSpend skipped
    //    by the race-replay guard — no double-cost on the ledger) ─────
    const buckets = await assertRead(() =>
      getTestClient().aiSpendBucket.findMany({ where: { merchantId } }),
    );
    expect(buckets).toHaveLength(0);

    // ── No audit row (race-replay is NOT an audit event) ────────────────
    const audits = await assertRead(() =>
      getTestClient().auditLog.findMany({
        where: { merchantId, action: { startsWith: 'ai.' } },
      }),
    );
    expect(audits).toHaveLength(0);
  });
});
