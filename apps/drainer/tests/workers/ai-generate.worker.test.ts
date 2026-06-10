/**
 * Unit tests for the AI Worker (Epic F §F-8) — `processAiGenerateJob`
 * + `createAiGenerateWorker` factory.
 *
 * Mocked-Prisma + mocked-provider pattern. Real repositories run end-
 * to-end against the Prisma delegate mocks (catches integration of
 * payload → repo args → Prisma call shape). The provider is mocked at
 * the @winback/ai boundary via `selectActiveProvider`.
 *
 * Critical invariants this suite locks (mapped to user-mandated and
 * Phase-1 audit watchpoints):
 *
 *   - Test 1  : no-op on already-completed row — no provider, no tx,
 *               no spend increment (USER-MANDATED REGRESSION #1).
 *   - Test 2  : markCompleted updatedCount=0 (race-replay) → skip
 *               updateGeneratedText + incrementSpend; tx commits clean
 *               (USER-MANDATED REGRESSION #2).
 *   - Test 17 : cross-tenant payload safety — tenant-scoped findUnique
 *               returns null → worker no-ops (SECURITY REGRESSION LOCK).
 *   - happy   : pending row → provider → 3-write tx with correct args.
 *   - cost    : BigInt costMicrocents preserved (no Number cast) and
 *               flows into BOTH markCompleted.costMicrocents AND
 *               incrementSpend.deltaMicrocents.
 *   - pickup  : findUnique runs BEFORE provider.generate (idempotent
 *               pickup contract per §F-8). Worker reads STORED prompts
 *               off the row — does NOT re-build via buildWinbackPrompt.
 *   - tx-order: provider.generate runs BEFORE any prisma.$transaction
 *               (locked rule: no external HTTP inside a Postgres tx).
 *   - retry   : AiProviderRateLimitError / AiProviderTransientError →
 *               re-thrown (BullMQ retries).
 *   - fail    : AiProviderContentBlockedError → markFailed(
 *               lastError='content_blocked') + audit
 *               AUDIT_ACTIONS.ai.content_blocked.
 *               AiProviderAuthError → lastError='auth' + audit
 *               AUDIT_ACTIONS.ai.generation_failed.
 *               AiProviderInvalidRequestError → lastError='invalid_request'
 *               + audit AUDIT_ACTIONS.ai.generation_failed.
 *               Non-retryable error path does NOT increment spend.
 *               Audit row written in SAME tx as markFailed (rule #14).
 *   - Q-A2    : Unknown error class (not AiProviderError) → re-thrown;
 *               no row mutation, no audit.
 *   - Q-A3    : audit context shape locked
 *               { providerErrorCode, jobId, attempt, errorMessage } and
 *               errorMessage truncated to 500 chars.
 *   - factory : QUEUE_NAMES.ai.generate, concurrency=1, lockDuration=
 *               30min, connection name 'worker.ai-generate'.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Selective mock of @winback/ai — replace `selectActiveProvider` with a
// controllable stub; pass everything else through (getAiConfig reads
// process.env stubs from vitest.config.ts; estimateCostMicrocents runs
// real BigInt arithmetic; the typed error classes are constructed by
// tests). Mirrors the customer-state-changed.test.ts pattern for
// @winback/shopify.
vi.mock('@winback/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@winback/ai')>();
  return {
    ...actual,
    selectActiveProvider: vi.fn(),
  };
});

// Mock bullmq's Worker constructor — only the `createAiGenerateWorker`
// factory test exercises it; processAiGenerateJob tests bypass the
// Worker entirely and drive the processor directly. Capturing
// construction options without a live Redis dependency.
const workerConstructorCalls: {
  name: string;
  opts: { connection: unknown; concurrency: number; lockDuration: number };
}[] = [];
const workerInstances: { on: Mock; close: Mock }[] = [];

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation((name: string, _processor, opts) => {
    workerConstructorCalls.push({ name, opts });
    const instance = {
      on: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- Intentional no-op mock for vi.fn return-typing; empty body documents deliberate-no-op rather than a forgotten stub.
      close: vi.fn(async () => {}),
    };
    workerInstances.push(instance);
    return instance;
  }),
}));

// Mock @winback/queue's createRedisClient — Workers MUST have their own
// connection (BullMQ blocking-commands rule); we return a sentinel that
// the factory test asserts is forwarded into the Worker constructor's
// `connection` opt.
const fakeRedisClient = { __fakeRedis: true } as const;
vi.mock('@winback/queue', () => ({
  createRedisClient: vi.fn(() => fakeRedisClient),
}));

// Mock @winback/shopify's discount-mint surface (A4 §4.2). The Option-B mint
// path calls buildAdminClient → createWinbackDiscountCode (real Admin HTTP) +
// deriveWinbackDiscountCode. Stub all three so unit tests drive the mint
// branch deterministically with no Shopify dependency. Existing non-discount
// tests never enter the branch (discountValuePercent: null) so the stubs are
// inert for them. `substituteDiscountTokens` is NOT stubbed — it's pure and
// comes from @winback/ai (passed through), so the real V9 substitution runs.
vi.mock('@winback/shopify', () => ({
  buildAdminClient: vi.fn(() => ({ __adminClient: true })),
  deriveWinbackDiscountCode: vi.fn(() => 'WB-TESTCODE00000000'),
  createWinbackDiscountCode: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  AiProviderAuthError,
  AiProviderContentBlockedError,
  AiProviderInvalidRequestError,
  AiProviderRateLimitError,
  AiProviderTransientError,
  selectActiveProvider,
} from '@winback/ai';
import { AUDIT_ACTIONS } from '@winback/contracts';
import type { WinbackPrisma } from '@winback/db';
import type { Queues } from '@winback/queue';
import { createRedisClient } from '@winback/queue';
import { createWinbackDiscountCode, deriveWinbackDiscountCode } from '@winback/shopify';
import type { ShopifyConfig } from '@winback/shopify';
import type { Job } from 'bullmq';

import type { DrainerContext } from '../../src/context.js';
import {
  type AiGenerateJobPayload,
  createAiGenerateWorker,
  processAiGenerateJob,
} from '../../src/workers/ai-generate.worker.js';

// ---------------------------------------------------------------------------
// Mock plumbing (modelled on customer-state-changed.test.ts:70+)
// ---------------------------------------------------------------------------

interface AiGenRowMock {
  status: 'pending' | 'completed' | 'failed';
  provider: string;
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  // A5 / §5 — selected by the worker for the staleness check at
  // STEP 1.5. The check itself only runs after the status guard
  // (pending rows only), but the field is still selected, so the mock
  // must always provide it. Default in `makeCtx` is `new Date()`
  // (a fresh row); A5 tests override with a >24h-old Date to exercise
  // the stale path.
  createdAt: Date;
  merchant: { shop: string };
  // A4 §4.2 — discount minting (Option B). All optional: the `findUnique`
  // mock defaults `discountValuePercent` to `null` (no discount → worker skips
  // the mint branch), so existing non-discount rows need not set it. Discount
  // tests set `discountValuePercent` + `customer` explicitly. `customer` +
  // `shopifyDiscountId` are read ONLY inside the mint branch.
  discountValuePercent?: number | null;
  shopifyDiscountId?: string | null;
  customer?: { shopifyCustomerId: string; deletedAt: Date | null } | null;
}

interface MockState {
  aiGenRow: AiGenRowMock | null;
  markCompletedUpdatedCount: number;
  markCompletedRows: { where: Record<string, unknown>; data: Record<string, unknown> }[];
  markFailedRows: { where: Record<string, unknown>; data: Record<string, unknown> }[];
  messageUpdates: { where: Record<string, unknown>; data: Record<string, unknown> }[];
  spendBucketUpserts: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }[];
  auditLogRows: { data: Record<string, unknown> }[];
  /** A4 §4.2 — attributionDirectWindowDays returned by merchantSettings. */
  attributionDirectWindowDays: number;
}

interface PrismaMocks {
  findUnique: Mock;
  aiGenUpdateMany: Mock;
  merchantSettingsFindUnique: Mock;
  messageUpdateMany: Mock;
  spendBucketUpsert: Mock;
  auditLogCreate: Mock;
  transaction: Mock;
}

function makeCtx(initial: Partial<MockState> = {}): {
  ctx: DrainerContext;
  state: MockState;
  prismaMocks: PrismaMocks;
} {
  // Use `in` checks for nullable fields so `{ aiGenRow: null }` is
  // honoured (vs collapsed to the default by `??`).
  const state: MockState = {
    aiGenRow:
      'aiGenRow' in initial
        ? initial.aiGenRow ?? null
        : {
            status: 'pending',
            provider: 'deepseek',
            modelId: 'deepseek-v4-flash',
            systemPrompt: 'You are a winback specialist.',
            userPrompt: 'Customer Alice has not ordered in 45 days.',
            createdAt: new Date(),
            merchant: { shop: 'foo.myshopify.com' },
            // Default row offers NO discount — keeps every existing test on
            // the original (no-mint) path. Discount-path tests set this
            // explicitly + provide `customer`.
            discountValuePercent: null,
          },
    markCompletedUpdatedCount: initial.markCompletedUpdatedCount ?? 1,
    markCompletedRows: [],
    markFailedRows: [],
    messageUpdates: [],
    spendBucketUpserts: [],
    auditLogRows: [],
    attributionDirectWindowDays: initial.attributionDirectWindowDays ?? 14,
  };

  // Default-injects `discountValuePercent: null` so existing non-discount mock
  // rows (which predate A4 §4.2) take the no-mint path. Rows that set it
  // explicitly override. Also surfaces `customer`/`shopifyDiscountId` as null
  // when unset, matching the worker's `?? null` reads. (Tests that override
  // findUnique directly must include these fields themselves.)
  const findUnique = vi.fn(async () =>
    state.aiGenRow === null
      ? null
      : {
          discountValuePercent: null,
          shopifyDiscountId: null,
          customer: null,
          ...state.aiGenRow,
        },
  );

  // aiGeneration.updateMany routes by data.status — markCompleted writes
  // status='completed'; markFailed writes status='failed'. Returns
  // `count: markCompletedUpdatedCount` for completed (race-replay
  // simulation); always `count: 1` for failed.
  const aiGenUpdateMany = vi.fn(
    async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (args.data.status === 'completed') {
        state.markCompletedRows.push(args);
        return { count: state.markCompletedUpdatedCount };
      }
      if (args.data.status === 'failed') {
        state.markFailedRows.push(args);
        return { count: 1 };
      }
      return { count: 0 };
    },
  );

  const messageUpdateMany = vi.fn(
    async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      state.messageUpdates.push(args);
      return { count: 1 };
    },
  );

  const spendBucketUpsert = vi.fn(
    async (args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      state.spendBucketUpserts.push(args);
      return { id: 'bucket_1' };
    },
  );

  const auditLogCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    state.auditLogRows.push(args);
    return { id: 'audit_1' };
  });

  // A4 §4.2 — the worker reads attributionDirectWindowDays in the mint branch
  // (for the discount endsAt). Only called when discountValuePercent !== null.
  const merchantSettingsFindUnique = vi.fn(async () => ({
    attributionDirectWindowDays: state.attributionDirectWindowDays,
  }));

  // $transaction(fn) — the inner fn receives the same prisma stub so
  // the tx-cast pattern in the worker is exercised end-to-end.
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    return fn(prisma);
  });

  const prisma = {
    aiGeneration: { findUnique, updateMany: aiGenUpdateMany },
    merchantSettings: { findUnique: merchantSettingsFindUnique },
    message: { updateMany: messageUpdateMany },
    aiSpendBucket: { upsert: spendBucketUpsert },
    auditLog: { create: auditLogCreate },
    $transaction: transaction,
  } as unknown as WinbackPrisma;

  const queues = {} as unknown as Queues;
  const shopifyConfig = {} as unknown as ShopifyConfig;

  const ctx: DrainerContext = { prisma, queues, shopifyConfig };

  return {
    ctx,
    state,
    prismaMocks: {
      findUnique,
      aiGenUpdateMany,
      merchantSettingsFindUnique,
      messageUpdateMany,
      spendBucketUpsert,
      auditLogCreate,
      transaction,
    },
  };
}

function makeJob(
  overrides: Partial<{
    jobId: string;
    attemptsMade: number;
    aiGenerationId: string;
    merchantId: string;
    customerId: string;
  }> = {},
): Job<AiGenerateJobPayload> {
  const aiGenerationId = overrides.aiGenerationId ?? 'gen_1';
  return {
    id: overrides.jobId ?? aiGenerationId,
    data: {
      aiGenerationId,
      merchantId: overrides.merchantId ?? 'm_1',
      customerId: overrides.customerId ?? 'c_1',
    },
    attemptsMade: overrides.attemptsMade ?? 0,
  } as unknown as Job<AiGenerateJobPayload>;
}

interface ProviderResultOverrides {
  content?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
}

function happyResult(overrides: ProviderResultOverrides = {}): {
  content: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
} {
  const inputTokens = overrides.inputTokens ?? 120;
  const outputTokens = overrides.outputTokens ?? 80;
  return {
    content: overrides.content ?? 'Hey Alice, we miss you...',
    inputTokens,
    outputTokens,
    totalTokens: overrides.totalTokens ?? inputTokens + outputTokens,
    latencyMs: overrides.latencyMs ?? 412,
  };
}

/**
 * Configure `selectActiveProvider` to return a stub provider whose
 * generate fn invokes `impl`. Returns the Mock so tests can introspect
 * call args.
 */
function setProviderGenerate(
  impl: (args: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    maxTokens: number;
    temperature: number;
  }) => Promise<unknown>,
): Mock {
  const generate = vi.fn(impl as never);
  vi.mocked(selectActiveProvider).mockReturnValue({
    name: 'deepseek',
    generate,
  } as never);
  return generate;
}

// ---------------------------------------------------------------------------
// User-mandated regression locks (Tests 1 + 2 from handoff.md)
// ---------------------------------------------------------------------------

describe('processAiGenerateJob — user-mandated regression locks', () => {
  it('Test 1: no-op on already-completed row without calling provider OR opening completion tx', async () => {
    const { ctx, state, prismaMocks } = makeCtx({
      aiGenRow: {
        status: 'completed',
        provider: 'deepseek',
        modelId: 'deepseek-v4-flash',
        systemPrompt: 'sys',
        userPrompt: 'usr',
        createdAt: new Date(),
        merchant: { shop: 'foo.myshopify.com' },
      },
    });
    const generate = setProviderGenerate(async () => happyResult());

    await processAiGenerateJob(ctx, makeJob());

    expect(generate).not.toHaveBeenCalled();
    expect(prismaMocks.transaction).not.toHaveBeenCalled();
    expect(state.spendBucketUpserts).toHaveLength(0);
    expect(state.markCompletedRows).toHaveLength(0);
    expect(state.markFailedRows).toHaveLength(0);
    expect(state.messageUpdates).toHaveLength(0);
    expect(state.auditLogRows).toHaveLength(0);
  });

  it('Test 1 variant: status="failed" row also no-ops (idempotent replay covers all terminal statuses)', async () => {
    const { ctx, state, prismaMocks } = makeCtx({
      aiGenRow: {
        status: 'failed',
        provider: 'deepseek',
        modelId: 'deepseek-v4-flash',
        systemPrompt: 'sys',
        userPrompt: 'usr',
        createdAt: new Date(),
        merchant: { shop: 'foo.myshopify.com' },
      },
    });
    const generate = setProviderGenerate(async () => happyResult());

    await processAiGenerateJob(ctx, makeJob());

    expect(generate).not.toHaveBeenCalled();
    expect(prismaMocks.transaction).not.toHaveBeenCalled();
    expect(state.spendBucketUpserts).toHaveLength(0);
    expect(state.auditLogRows).toHaveLength(0);
  });

  it('Test 2: markCompleted updatedCount=0 (race-replay) → updateGeneratedText + incrementSpend NOT called; tx commits clean', async () => {
    const { ctx, state, prismaMocks } = makeCtx({ markCompletedUpdatedCount: 0 });
    const generate = setProviderGenerate(async () => happyResult());

    // Must not throw — the early-exit returns from inside the tx
    // callback; outer await resolves normally.
    await expect(processAiGenerateJob(ctx, makeJob())).resolves.toBeUndefined();

    // Provider WAS called (we picked up a pending row).
    expect(generate).toHaveBeenCalledTimes(1);
    // Completion tx opened.
    expect(prismaMocks.transaction).toHaveBeenCalledTimes(1);
    // markCompleted attempted (returned count 0).
    expect(state.markCompletedRows).toHaveLength(1);
    // Downstream writes SKIPPED via the early-exit.
    expect(state.messageUpdates).toHaveLength(0);
    expect(state.spendBucketUpserts).toHaveLength(0);
    // Race-replay is NOT an audit event.
    expect(state.auditLogRows).toHaveLength(0);
    expect(state.markFailedRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant security regression lock (Test 17 from Phase 1 audit)
// ---------------------------------------------------------------------------

describe('processAiGenerateJob — cross-tenant payload safety (Test 17)', () => {
  it('cross-tenant payload (extension filters by tenant → findUnique returns null) → worker no-ops', async () => {
    // The Prisma extension's tenant-scoped read hook injects WHERE
    // merchantId = <active-scope>. A malicious or buggy job carrying
    // an aiGenerationId belonging to a DIFFERENT merchant gets
    // filtered → findUnique returns null. Worker MUST no-op (no
    // provider, no tx, no audit). Third layer of defence-in-depth.
    //
    // We simulate the extension's filter by stubbing findUnique to
    // return null. Job payload claims merchantId='m_B' but the row
    // (hypothetically) belongs to 'm_A'; the extension would return
    // null because the injected WHERE merchantId='m_B' matched no row.
    const { ctx, state, prismaMocks } = makeCtx({ aiGenRow: null });
    const generate = setProviderGenerate(async () => happyResult());

    await processAiGenerateJob(
      ctx,
      makeJob({ merchantId: 'm_B', aiGenerationId: 'gen_belongs_to_m_A' }),
    );

    // The pickup read happened (extension would have injected its
    // tenant filter on this very call).
    expect(prismaMocks.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMocks.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'gen_belongs_to_m_A' } }),
    );
    // Worker no-ops on null.
    expect(generate).not.toHaveBeenCalled();
    expect(prismaMocks.transaction).not.toHaveBeenCalled();
    expect(state.markCompletedRows).toHaveLength(0);
    expect(state.markFailedRows).toHaveLength(0);
    expect(state.messageUpdates).toHaveLength(0);
    expect(state.spendBucketUpserts).toHaveLength(0);
    expect(state.auditLogRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('processAiGenerateJob — happy path', () => {
  it('pending row → provider.generate succeeds → markCompleted + updateGeneratedText + incrementSpend all called inside one tx with correct args', async () => {
    const { ctx, state, prismaMocks } = makeCtx();
    const generate = setProviderGenerate(async () =>
      happyResult({
        content: 'Hey Alice!',
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        latencyMs: 500,
      }),
    );

    await processAiGenerateJob(ctx, makeJob());

    // Provider called with prompts read from the AiGeneration row
    // (NOT re-built — worker MUST NOT call buildWinbackPrompt).
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith({
      model: 'deepseek-v4-flash',
      systemPrompt: 'You are a winback specialist.',
      userPrompt: 'Customer Alice has not ordered in 45 days.',
      maxTokens: 300,
      temperature: 0.7,
    });

    expect(prismaMocks.transaction).toHaveBeenCalledTimes(1);
    expect(state.markCompletedRows).toHaveLength(1);
    expect(state.messageUpdates).toHaveLength(1);
    expect(state.spendBucketUpserts).toHaveLength(1);
    expect(state.auditLogRows).toHaveLength(0);
    expect(state.markFailedRows).toHaveLength(0);

    const mc = state.markCompletedRows[0]!;
    expect(mc.where).toMatchObject({ id: 'gen_1', status: 'pending' });
    expect(mc.data.status).toBe('completed');
    expect(mc.data.generatedText).toBe('Hey Alice!');
    expect(mc.data.inputTokens).toBe(200);
    expect(mc.data.outputTokens).toBe(100);
    expect(mc.data.totalTokens).toBe(300);
    expect(mc.data.latencyMs).toBe(500);
    expect(typeof mc.data.costMicrocents).toBe('bigint');

    const mu = state.messageUpdates[0]!;
    expect(mu.where).toMatchObject({ aiGenerationId: 'gen_1' });
    expect(mu.data.generatedText).toBe('Hey Alice!');

    const su = state.spendBucketUpserts[0]!;
    expect(su.where).toMatchObject({
      merchantId_date: expect.objectContaining({ merchantId: 'm_1' }) as unknown,
    });
    expect(typeof (su.create).spentMicrocents).toBe('bigint');
    expect((su.create).merchantId).toBe('m_1');
  });

  it('cost arithmetic: BigInt costMicrocents preserved (no Number cast) — flows into BOTH markCompleted.costMicrocents AND incrementSpend.deltaMicrocents', async () => {
    const { ctx, state } = makeCtx();
    setProviderGenerate(async () =>
      happyResult({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    );

    await processAiGenerateJob(ctx, makeJob());

    // DeepSeek v4-flash: input 14_000_000 microcents/1M tokens +
    // output 28_000_000 microcents/1M tokens. At 1M in + 1M out:
    // 14_000_000 + 28_000_000 = 42_000_000 microcents.
    const expectedCost = 42_000_000n;

    const completedCost = state.markCompletedRows[0]!.data.costMicrocents;
    expect(typeof completedCost).toBe('bigint');
    expect(completedCost).toBe(expectedCost);

    const upsertCreate = state.spendBucketUpserts[0]!.create;
    expect(typeof upsertCreate.spentMicrocents).toBe('bigint');
    expect(upsertCreate.spentMicrocents).toBe(expectedCost);
  });
});

// ---------------------------------------------------------------------------
// Idempotent pickup — row missing
// ---------------------------------------------------------------------------

describe('processAiGenerateJob — idempotent pickup', () => {
  it('AiGeneration row missing (findUnique returns null) → no-op + log; no provider call, no tx', async () => {
    const { ctx, state, prismaMocks } = makeCtx({ aiGenRow: null });
    const generate = setProviderGenerate(async () => happyResult());

    await processAiGenerateJob(ctx, makeJob());

    expect(prismaMocks.findUnique).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    expect(prismaMocks.transaction).not.toHaveBeenCalled();
    expect(state.markCompletedRows).toHaveLength(0);
    expect(state.markFailedRows).toHaveLength(0);
    expect(state.auditLogRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Retryable provider errors → re-thrown to BullMQ
// ---------------------------------------------------------------------------

describe('processAiGenerateJob — retryable provider errors re-thrown to BullMQ', () => {
  it('AiProviderRateLimitError (429) → re-thrown; no markFailed, no audit (Q-A1 defers exhaustion audit to M10)', async () => {
    const { ctx, state, prismaMocks } = makeCtx();
    setProviderGenerate(async () => {
      throw new AiProviderRateLimitError('429 from DeepSeek');
    });

    await expect(processAiGenerateJob(ctx, makeJob())).rejects.toBeInstanceOf(
      AiProviderRateLimitError,
    );

    expect(prismaMocks.transaction).not.toHaveBeenCalled();
    expect(state.markFailedRows).toHaveLength(0);
    expect(state.markCompletedRows).toHaveLength(0);
    expect(state.auditLogRows).toHaveLength(0);
    expect(state.spendBucketUpserts).toHaveLength(0);
  });

  it('AiProviderTransientError (503) → re-thrown; no markFailed, no audit', async () => {
    const { ctx, state, prismaMocks } = makeCtx();
    setProviderGenerate(async () => {
      throw new AiProviderTransientError('503 upstream');
    });

    await expect(processAiGenerateJob(ctx, makeJob())).rejects.toBeInstanceOf(
      AiProviderTransientError,
    );

    expect(prismaMocks.transaction).not.toHaveBeenCalled();
    expect(state.markFailedRows).toHaveLength(0);
    expect(state.auditLogRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Non-retryable provider errors → markFailed + audit (one tx)
// ---------------------------------------------------------------------------

describe('processAiGenerateJob — non-retryable provider errors (markFailed + audit, one tx)', () => {
  it('AiProviderContentBlockedError → markFailed(lastError="content_blocked") + audit AUDIT_ACTIONS.ai.content_blocked', async () => {
    const { ctx, state, prismaMocks } = makeCtx();
    setProviderGenerate(async () => {
      throw new AiProviderContentBlockedError('moderation flagged');
    });

    await processAiGenerateJob(ctx, makeJob({ attemptsMade: 1 }));

    expect(prismaMocks.transaction).toHaveBeenCalledTimes(1);
    expect(state.markFailedRows).toHaveLength(1);
    const mf = state.markFailedRows[0]!;
    expect(mf.where).toMatchObject({ id: 'gen_1', status: 'pending' });
    expect(mf.data.status).toBe('failed');
    expect(mf.data.lastError).toBe('content_blocked');

    expect(state.auditLogRows).toHaveLength(1);
    const audit = state.auditLogRows[0]!.data;
    expect(audit.merchantId).toBe('m_1');
    expect(audit.shop).toBe('foo.myshopify.com');
    expect(audit.actorType).toBe('system');
    expect(audit.actorId).toBe('drainer');
    expect(audit.action).toBe(AUDIT_ACTIONS.ai.content_blocked);
    expect(audit.targetType).toBe('ai_generation');
    expect(audit.targetId).toBe('gen_1');
    expect(audit.context).toMatchObject({
      providerErrorCode: 'content_blocked',
      jobId: 'gen_1',
      attempt: 1,
      errorMessage: 'moderation flagged',
    });

    // No spend on failed generation; no markCompleted attempted.
    expect(state.spendBucketUpserts).toHaveLength(0);
    expect(state.markCompletedRows).toHaveLength(0);
  });

  it('AiProviderAuthError → markFailed(lastError="auth") + audit AUDIT_ACTIONS.ai.generation_failed', async () => {
    const { ctx, state } = makeCtx();
    setProviderGenerate(async () => {
      throw new AiProviderAuthError('401 invalid key');
    });

    await processAiGenerateJob(ctx, makeJob());

    expect(state.markFailedRows[0]!.data.lastError).toBe('auth');
    const audit = state.auditLogRows[0]!.data;
    expect(audit.action).toBe(AUDIT_ACTIONS.ai.generation_failed);
    expect((audit.context as Record<string, unknown>).providerErrorCode).toBe('auth');
  });

  it('AiProviderInvalidRequestError → markFailed(lastError="invalid_request") + audit AUDIT_ACTIONS.ai.generation_failed', async () => {
    const { ctx, state } = makeCtx();
    setProviderGenerate(async () => {
      throw new AiProviderInvalidRequestError('400 malformed body');
    });

    await processAiGenerateJob(ctx, makeJob());

    expect(state.markFailedRows[0]!.data.lastError).toBe('invalid_request');
    const audit = state.auditLogRows[0]!.data;
    expect(audit.action).toBe(AUDIT_ACTIONS.ai.generation_failed);
    expect((audit.context as Record<string, unknown>).providerErrorCode).toBe(
      'invalid_request',
    );
  });

  it('non-retryable error path does NOT write to incrementSpend (no spend on failed generation)', async () => {
    const { ctx, state } = makeCtx();
    setProviderGenerate(async () => {
      throw new AiProviderContentBlockedError('moderation flagged');
    });

    await processAiGenerateJob(ctx, makeJob());

    expect(state.spendBucketUpserts).toHaveLength(0);
  });

  it('audit context errorMessage truncated to 500 chars (Q-A3 truncation discipline)', async () => {
    const { ctx, state } = makeCtx();
    const longMessage = 'x'.repeat(800);
    setProviderGenerate(async () => {
      throw new AiProviderContentBlockedError(longMessage);
    });

    await processAiGenerateJob(ctx, makeJob());

    const ctxField = state.auditLogRows[0]!.data.context as Record<string, unknown>;
    const errorMessage = ctxField.errorMessage as string;
    expect(errorMessage).toHaveLength(500);
    expect(errorMessage).toBe('x'.repeat(500));
  });

  it('markFailed + auditLog.append run in the SAME prisma.$transaction call (ARCHITECTURE rule #14)', async () => {
    const { ctx, prismaMocks } = makeCtx();
    setProviderGenerate(async () => {
      throw new AiProviderAuthError('401');
    });

    await processAiGenerateJob(ctx, makeJob());

    // Exactly one $transaction call. Both writes happen inside it.
    expect(prismaMocks.transaction).toHaveBeenCalledTimes(1);
    expect(prismaMocks.aiGenUpdateMany).toHaveBeenCalledTimes(1);
    expect(prismaMocks.auditLogCreate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Unknown error class (Q-A2 — re-throw, do NOT close the row)
// ---------------------------------------------------------------------------

describe('processAiGenerateJob — unknown error class (Q-A2)', () => {
  it('non-AiProviderError (plain Error) → re-thrown; no markFailed, no audit (don\'t swallow into close-the-row)', async () => {
    const { ctx, state, prismaMocks } = makeCtx();
    setProviderGenerate(async () => {
      throw new Error('totally unexpected bug in our SDK mapper');
    });

    await expect(processAiGenerateJob(ctx, makeJob())).rejects.toThrow(
      'totally unexpected bug in our SDK mapper',
    );

    expect(prismaMocks.transaction).not.toHaveBeenCalled();
    expect(state.markFailedRows).toHaveLength(0);
    expect(state.markCompletedRows).toHaveLength(0);
    expect(state.auditLogRows).toHaveLength(0);
    expect(state.spendBucketUpserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ordering invariants
// ---------------------------------------------------------------------------

describe('processAiGenerateJob — ordering invariants', () => {
  it('provider.generate is called BEFORE prisma.$transaction is ever invoked (locked rule: no external HTTP inside Postgres tx)', async () => {
    const { ctx, prismaMocks } = makeCtx();
    let providerCalledAt = -1;
    let transactionCalledAt = -1;
    let seq = 0;
    const generate = setProviderGenerate(async () => {
      providerCalledAt = seq++;
      return happyResult();
    });
    prismaMocks.transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        transactionCalledAt = seq++;
        return fn(ctx.prisma);
      },
    );

    await processAiGenerateJob(ctx, makeJob());

    expect(generate).toHaveBeenCalledTimes(1);
    expect(prismaMocks.transaction).toHaveBeenCalledTimes(1);
    expect(providerCalledAt).toBeGreaterThanOrEqual(0);
    expect(transactionCalledAt).toBeGreaterThanOrEqual(0);
    expect(providerCalledAt).toBeLessThan(transactionCalledAt);
  });

  it('idempotent-pickup findUnique runs BEFORE provider.generate; worker reads STORED prompts off the row (does NOT re-build via buildWinbackPrompt)', async () => {
    const { ctx, prismaMocks } = makeCtx();
    let findUniqueAt = -1;
    let providerAt = -1;
    let seq = 0;
    prismaMocks.findUnique.mockImplementation(async () => {
      findUniqueAt = seq++;
      return {
        status: 'pending' as const,
        provider: 'deepseek',
        modelId: 'deepseek-v4-flash',
        systemPrompt: 'STORED_SYSTEM_PROMPT',
        userPrompt: 'STORED_USER_PROMPT',
        createdAt: new Date(),
        merchant: { shop: 'foo.myshopify.com' },
        discountValuePercent: null,
      };
    });
    const generate = setProviderGenerate(async () => {
      providerAt = seq++;
      return happyResult();
    });

    await processAiGenerateJob(ctx, makeJob());

    expect(findUniqueAt).toBe(0);
    expect(providerAt).toBe(1);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: 'STORED_SYSTEM_PROMPT',
        userPrompt: 'STORED_USER_PROMPT',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Factory configuration (createAiGenerateWorker)
// ---------------------------------------------------------------------------

describe('createAiGenerateWorker — factory config', () => {
  it('uses QUEUE_NAMES.ai.generate, concurrency=1, lockDuration=30min, dedicated "worker.ai-generate" connection', () => {
    workerConstructorCalls.length = 0;
    workerInstances.length = 0;
    vi.mocked(createRedisClient).mockClear();

    const { ctx } = makeCtx();
    const worker = createAiGenerateWorker(ctx);

    // Workers MUST have their own Redis connection (BullMQ blocking-
    // commands rule). The factory calls createRedisClient with a
    // descriptive name so the connection is identifiable in CLIENT LIST.
    expect(createRedisClient).toHaveBeenCalledWith('worker.ai-generate');

    expect(workerConstructorCalls).toHaveLength(1);
    const call = workerConstructorCalls[0]!;
    expect(call.name).toBe('ai.generate');
    expect(call.opts.connection).toBe(fakeRedisClient);
    expect(call.opts.concurrency).toBe(1);
    expect(call.opts.lockDuration).toBe(30 * 60 * 1000);

    // Factory wired both lifecycle listeners.
    expect(workerInstances).toHaveLength(1);
    expect(workerInstances[0]!.on).toHaveBeenCalledWith('failed', expect.any(Function));
    expect(workerInstances[0]!.on).toHaveBeenCalledWith('error', expect.any(Function));

    expect(worker).toBe(workerInstances[0]);
  });
});

// ---------------------------------------------------------------------------
// A5 / POST-EPIC-F §5 — stale-generation skip
//
// STEP 1.5 in `processAiGenerateJob`: after the existence + status
// guards (pending rows only), gate on
// `Date.now() - row.createdAt > 24h`. Stale → single atomic
// `markFailed(lastError='generation_stale')` UPDATE, return normally.
// No `$transaction` wrapper (no related audit). No LLM call. No
// AiSpendBucket. No Message update. BullMQ sees no error → no retry.
//
// The boundary is strict `>`: a row at exactly 24h still proceeds.
// ---------------------------------------------------------------------------

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

describe('processAiGenerateJob — A5 stale-generation skip', () => {
  it('fresh row (createdAt 1h ago) → proceeds to provider call; markFailed NOT called for staleness', async () => {
    const { ctx, state, prismaMocks } = makeCtx({
      aiGenRow: {
        status: 'pending',
        provider: 'deepseek',
        modelId: 'deepseek-v4-flash',
        systemPrompt: 'sys',
        userPrompt: 'usr',
        // 1 hour ago — well under the 24h threshold.
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        merchant: { shop: 'foo.myshopify.com' },
      },
    });
    const generate = setProviderGenerate(async () => happyResult());

    await processAiGenerateJob(ctx, makeJob());

    // Provider WAS called; the row took the happy path through STEP 2.
    expect(generate).toHaveBeenCalledTimes(1);
    // Completion tx ran (3-write atomic). markFailed for staleness did
    // NOT fire (no 'generation_stale' UPDATE landed).
    expect(state.markCompletedRows).toHaveLength(1);
    const staleFails = state.markFailedRows.filter(
      (r) => r.data.lastError === 'generation_stale',
    );
    expect(staleFails).toHaveLength(0);
    // Sanity: the markFailed mock recorded zero rows total.
    expect(state.markFailedRows).toHaveLength(0);
    // No audit row (staleness path doesn't write one anyway; provider
    // happy path also doesn't).
    expect(state.auditLogRows).toHaveLength(0);
    // The completion tx was opened (only the 3-write completion tx
    // runs `$transaction` in this flow; staleness skip does NOT).
    expect(prismaMocks.transaction).toHaveBeenCalledTimes(1);
  });

  it('stale row (createdAt 25h ago) → markFailed(lastError="generation_stale"), provider NOT called, no $transaction, no audit, no spend', async () => {
    const { ctx, state, prismaMocks } = makeCtx({
      aiGenRow: {
        status: 'pending',
        provider: 'deepseek',
        modelId: 'deepseek-v4-flash',
        systemPrompt: 'sys',
        userPrompt: 'usr',
        // 25 hours ago — over the 24h threshold.
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        merchant: { shop: 'foo.myshopify.com' },
      },
    });
    const generate = setProviderGenerate(async () => happyResult());

    await processAiGenerateJob(ctx, makeJob());

    // Provider was NOT called — staleness short-circuited before STEP 2.
    expect(generate).not.toHaveBeenCalled();

    // Exactly one markFailed UPDATE landed, gated on status='pending',
    // with the canonical lastError string.
    expect(state.markFailedRows).toHaveLength(1);
    const failed = state.markFailedRows[0]!;
    expect(failed.data.status).toBe('failed');
    expect(failed.data.lastError).toBe('generation_stale');
    expect(failed.data.failedAt).toBeInstanceOf(Date);
    // The WHERE clause must include status='pending' for the repo's
    // idempotent-replay guard.
    expect(failed.where.status).toBe('pending');
    expect(failed.where.id).toBe('gen_1');

    // No $transaction was opened — staleness skip is a single atomic
    // UPDATE, NOT a multi-write tx (the user-mandated call: unlike
    // handleProviderError which pairs markFailed with an audit).
    expect(prismaMocks.transaction).not.toHaveBeenCalled();

    // No audit row (`'generation_stale'` is a lastError string, not a
    // registered AUDIT_ACTIONS constant — same pattern as 'content_filter').
    expect(state.auditLogRows).toHaveLength(0);

    // No spend bucket increment, no message update — STEP 4 never ran.
    expect(state.spendBucketUpserts).toHaveLength(0);
    expect(state.messageUpdates).toHaveLength(0);
    expect(state.markCompletedRows).toHaveLength(0);
  });

  it('boundary: createdAt exactly 24h ago → PROCEEDS (strict `>` — sub-second precision not load-bearing)', async () => {
    // Pin Date.now() with fake timers. Without this, the sub-ms gap
    // between `new Date(Date.now() - 24h)` at fixture setup and the
    // worker's `Date.now() - row.createdAt` check makes the difference
    // strictly > 24h (by 1+ ms of test runtime), wrongly firing the
    // stale path. Slow CI surfaced this; fast local machines were
    // hitting the sub-ms-gap lottery. Locking Date.now() makes the
    // boundary-at-exactly-24h test deterministic.
    const pinnedNow = new Date('2026-06-10T12:00:00.000Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(pinnedNow);
    try {
      const { ctx, state } = makeCtx({
        aiGenRow: {
          status: 'pending',
          provider: 'deepseek',
          modelId: 'deepseek-v4-flash',
          systemPrompt: 'sys',
          userPrompt: 'usr',
          // Exactly 24h ago — `Date.now() - createdAt === TWENTY_FOUR_HOURS_MS`,
          // which is NOT `> TWENTY_FOUR_HOURS_MS`. The boundary documents
          // intent: a 1-ms-younger row should still proceed.
          createdAt: new Date(pinnedNow - TWENTY_FOUR_HOURS_MS),
          merchant: { shop: 'foo.myshopify.com' },
        },
      });
      const generate = setProviderGenerate(async () => happyResult());

      await processAiGenerateJob(ctx, makeJob());

      // Boundary row proceeded — provider called, completion tx fired,
      // no staleness markFailed.
      expect(generate).toHaveBeenCalledTimes(1);
      expect(state.markCompletedRows).toHaveLength(1);
      expect(state.markFailedRows).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stale-skip return is normal completion (no throw) → BullMQ does NOT retry', async () => {
    const { ctx } = makeCtx({
      aiGenRow: {
        status: 'pending',
        provider: 'deepseek',
        modelId: 'deepseek-v4-flash',
        systemPrompt: 'sys',
        userPrompt: 'usr',
        createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000), // 2 days
        merchant: { shop: 'foo.myshopify.com' },
      },
    });
    // Spy a provider stub — we assert it is NEVER called, AND we
    // assert the worker's outer promise resolves cleanly (no thrown
    // error → BullMQ marks the job complete, classifier never runs,
    // no retry).
    setProviderGenerate(async () => happyResult());

    await expect(processAiGenerateJob(ctx, makeJob())).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A4 / POST-EPIC-F §4.2 — discount mint (Option B) + V9 substitution
//
// STEP 3.5 in `processAiGenerateJob`: after stale-skip + LLM success, when
// `row.discountValuePercent !== null`, derive the deterministic code, mint a
// customer-scoped Shopify discount, substitute the V9 tokens in the LLM
// output, and persist code + shopifyDiscountId + discount.created audit in the
// completion tx. `createWinbackDiscountCode` / `buildAdminClient` /
// `deriveWinbackDiscountCode` are mocked at the @winback/shopify boundary; the
// REAL `substituteDiscountTokens` (pure, from @winback/ai) runs.
// ---------------------------------------------------------------------------

const TOKENED_CONTENT =
  'Hey Alice, use {{DISCOUNT_CODE}} for {{DISCOUNT_VALUE_PERCENT}}% off!';
const STUB_CODE = 'WB-TESTCODE00000000';
const STUB_DISCOUNT_ID = 'gid://shopify/DiscountCodeNode/777';

function discountRow(overrides: Partial<AiGenRowMock> = {}): AiGenRowMock {
  return {
    status: 'pending',
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    systemPrompt: 'sys',
    userPrompt: 'usr {{DISCOUNT_CODE}}',
    createdAt: new Date(),
    merchant: { shop: 'foo.myshopify.com' },
    discountValuePercent: 15,
    shopifyDiscountId: null,
    customer: { shopifyCustomerId: 'gid://shopify/Customer/42', deletedAt: null },
    ...overrides,
  };
}

describe('processAiGenerateJob — A4 §4.2 discount mint (Option B)', () => {
  beforeEach(() => {
    vi.mocked(createWinbackDiscountCode).mockReset();
    vi.mocked(deriveWinbackDiscountCode).mockReset();
    vi.mocked(deriveWinbackDiscountCode).mockReturnValue(STUB_CODE);
  });

  it('discount intended + customer present → mints (customer-scoped, derived code, window endsAt), substitutes tokens, persists code + shopifyDiscountId, writes discount.created audit', async () => {
    const { ctx, state, prismaMocks } = makeCtx({ aiGenRow: discountRow() });
    vi.mocked(createWinbackDiscountCode).mockResolvedValue({
      code: STUB_CODE,
      shopifyDiscountId: STUB_DISCOUNT_ID,
      alreadyExisted: false,
    });
    setProviderGenerate(async () => happyResult({ content: TOKENED_CONTENT }));

    await processAiGenerateJob(ctx, makeJob());

    // Mint called once with customer-scoped args + derived code.
    expect(createWinbackDiscountCode).toHaveBeenCalledTimes(1);
    const mintArgs = vi.mocked(createWinbackDiscountCode).mock.calls[0]![1];
    expect(mintArgs).toMatchObject({
      merchantId: 'm_1',
      customerGid: 'gid://shopify/Customer/42',
      code: STUB_CODE,
      valuePercent: 15,
    });
    expect(mintArgs.endsAt).toBeInstanceOf(Date);
    expect(deriveWinbackDiscountCode).toHaveBeenCalledTimes(1);
    // merchantSettings read for the attribution window.
    expect(prismaMocks.merchantSettingsFindUnique).toHaveBeenCalledTimes(1);

    // Substituted text reached BOTH the AiGeneration completion + the Message.
    const expectedText = 'Hey Alice, use WB-TESTCODE00000000 for 15% off!';
    expect(state.markCompletedRows[0]!.data.generatedText).toBe(expectedText);
    expect(state.messageUpdates[0]!.data.generatedText).toBe(expectedText);
    // Discount columns persisted in the completion tx.
    expect(state.markCompletedRows[0]!.data.discountCode).toBe(STUB_CODE);
    expect(state.markCompletedRows[0]!.data.shopifyDiscountId).toBe(STUB_DISCOUNT_ID);

    // discount.created audit, same tx; the CODE is NOT in the context.
    expect(state.auditLogRows).toHaveLength(1);
    const audit = state.auditLogRows[0]!.data;
    expect(audit.action).toBe(AUDIT_ACTIONS.discount.created);
    expect(audit.targetType).toBe('ai_generation');
    expect(audit.targetId).toBe('gen_1');
    expect(audit.context).toEqual({
      shopifyDiscountId: STUB_DISCOUNT_ID,
      valuePercent: 15,
    });
    expect(JSON.stringify(audit.context)).not.toContain(STUB_CODE);
  });

  it('discount disabled (discountValuePercent null) → no mint, no merchantSettings read, no discount audit, raw LLM text shipped', async () => {
    const { ctx, state, prismaMocks } = makeCtx(); // default row: no discount
    setProviderGenerate(async () => happyResult({ content: 'Plain message, no tokens.' }));

    await processAiGenerateJob(ctx, makeJob());

    expect(createWinbackDiscountCode).not.toHaveBeenCalled();
    expect(prismaMocks.merchantSettingsFindUnique).not.toHaveBeenCalled();
    expect(state.auditLogRows).toHaveLength(0);
    expect(state.markCompletedRows[0]!.data.generatedText).toBe('Plain message, no tokens.');
    expect(state.markCompletedRows[0]!.data.discountCode).toBeNull();
    expect(state.markCompletedRows[0]!.data.shopifyDiscountId).toBeNull();
  });

  it('discount intended but customer redacted (deletedAt set) → markFailed(discount_customer_redacted); NO mint, NO completion tx, NO audit', async () => {
    const { ctx, state, prismaMocks } = makeCtx({
      aiGenRow: discountRow({
        customer: { shopifyCustomerId: 'gid://shopify/Customer/42', deletedAt: new Date() },
      }),
    });
    const generate = setProviderGenerate(async () =>
      happyResult({ content: TOKENED_CONTENT }),
    );

    await processAiGenerateJob(ctx, makeJob());

    // Provider WAS called (mint gate is post-LLM-success), but the redacted
    // customer is terminal: no mint, no completion tx, no audit.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(createWinbackDiscountCode).not.toHaveBeenCalled();
    expect(prismaMocks.transaction).not.toHaveBeenCalled();
    expect(state.markCompletedRows).toHaveLength(0);
    expect(state.auditLogRows).toHaveLength(0);
    expect(state.markFailedRows).toHaveLength(1);
    expect(state.markFailedRows[0]!.data.lastError).toBe('discount_customer_redacted');
  });

  it('TAKEN self-heal: createWinbackDiscountCode returns alreadyExisted=true → still completes with the recovered id + audit', async () => {
    const { ctx, state } = makeCtx({ aiGenRow: discountRow() });
    vi.mocked(createWinbackDiscountCode).mockResolvedValue({
      code: STUB_CODE,
      shopifyDiscountId: STUB_DISCOUNT_ID,
      alreadyExisted: true,
    });
    setProviderGenerate(async () => happyResult({ content: TOKENED_CONTENT }));

    await processAiGenerateJob(ctx, makeJob());

    expect(state.markCompletedRows).toHaveLength(1);
    expect(state.markCompletedRows[0]!.data.shopifyDiscountId).toBe(STUB_DISCOUNT_ID);
    expect(state.auditLogRows).toHaveLength(1);
  });

  it('V9 fail-safe: LLM omitted the tokens → completes without throwing; text ships as-is (no hallucinated code), discount still recorded', async () => {
    const { ctx, state } = makeCtx({ aiGenRow: discountRow() });
    vi.mocked(createWinbackDiscountCode).mockResolvedValue({
      code: STUB_CODE,
      shopifyDiscountId: STUB_DISCOUNT_ID,
      alreadyExisted: false,
    });
    setProviderGenerate(async () => happyResult({ content: 'We miss you, come back!' }));

    await expect(processAiGenerateJob(ctx, makeJob())).resolves.toBeUndefined();

    const text = state.markCompletedRows[0]!.data.generatedText as string;
    expect(text).toBe('We miss you, come back!');
    expect(text).not.toContain(STUB_CODE);
    // The discount was still minted + tracked (V9 fail-safe logs, doesn't abort).
    expect(state.markCompletedRows[0]!.data.discountCode).toBe(STUB_CODE);
  });

  it('endsAt = now + attributionDirectWindowDays (pinned clock)', async () => {
    const pinnedNow = new Date('2026-06-10T12:00:00.000Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(pinnedNow);
    try {
      const { ctx } = makeCtx({
        aiGenRow: discountRow(),
        attributionDirectWindowDays: 30,
      });
      vi.mocked(createWinbackDiscountCode).mockResolvedValue({
        code: STUB_CODE,
        shopifyDiscountId: STUB_DISCOUNT_ID,
        alreadyExisted: false,
      });
      setProviderGenerate(async () => happyResult({ content: TOKENED_CONTENT }));

      await processAiGenerateJob(ctx, makeJob());

      const mintArgs = vi.mocked(createWinbackDiscountCode).mock.calls[0]![1];
      const expectedEndsAt = pinnedNow + 30 * 24 * 60 * 60 * 1000;
      expect(mintArgs.endsAt.getTime()).toBe(expectedEndsAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('race-replay with discount intended (markCompleted updatedCount=0) → mint ran (idempotent) but NO message update, NO audit', async () => {
    const { ctx, state } = makeCtx({
      aiGenRow: discountRow(),
      markCompletedUpdatedCount: 0,
    });
    vi.mocked(createWinbackDiscountCode).mockResolvedValue({
      code: STUB_CODE,
      shopifyDiscountId: STUB_DISCOUNT_ID,
      alreadyExisted: false,
    });
    setProviderGenerate(async () => happyResult({ content: TOKENED_CONTENT }));

    await expect(processAiGenerateJob(ctx, makeJob())).resolves.toBeUndefined();

    // Mint ran (deterministic + idempotent on Shopify's side); the race-loser
    // persists nothing past the markCompleted updatedCount=0 guard.
    expect(createWinbackDiscountCode).toHaveBeenCalledTimes(1);
    expect(state.messageUpdates).toHaveLength(0);
    expect(state.auditLogRows).toHaveLength(0);
  });
});
