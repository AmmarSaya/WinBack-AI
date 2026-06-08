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

import { describe, expect, it, vi, type Mock } from 'vitest';

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
  merchant: { shop: string };
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
}

interface PrismaMocks {
  findUnique: Mock;
  aiGenUpdateMany: Mock;
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
            merchant: { shop: 'foo.myshopify.com' },
          },
    markCompletedUpdatedCount: initial.markCompletedUpdatedCount ?? 1,
    markCompletedRows: [],
    markFailedRows: [],
    messageUpdates: [],
    spendBucketUpserts: [],
    auditLogRows: [],
  };

  const findUnique = vi.fn(async () => state.aiGenRow);

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

  // $transaction(fn) — the inner fn receives the same prisma stub so
  // the tx-cast pattern in the worker is exercised end-to-end.
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    return fn(prisma);
  });

  const prisma = {
    aiGeneration: { findUnique, updateMany: aiGenUpdateMany },
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
        merchant: { shop: 'foo.myshopify.com' },
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
