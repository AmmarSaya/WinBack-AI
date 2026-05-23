/**
 * Unit tests for AiGenerationRepository.
 *
 * Mocked-Prisma pattern (same shape as merchant-repository.test.ts /
 * gdpr-processor.test.ts). The point is to exercise the repository's
 * control flow + arg shapes — what `createPending` writes, that
 * `markCompleted` filters on `status: 'pending'` (the idempotency
 * pattern), that `markFailed` truncates `lastError`, etc. Behavior
 * that depends on Prisma extension semantics (tenant-scope assertion
 * on AiGeneration writes) is covered by `tenant-scope.test.ts` plus
 * the M3 integration smoke.
 *
 * The optional `tx` parameter is exercised in every method: each is
 * called both with the repository's own prisma (default path) and
 * with a passed-in `tx` (transactional path). Both must call the
 * same delegate methods with the same arguments.
 */

import { describe, expect, it, vi } from 'vitest';

import { AiGenerationRepository } from '../src/repositories/ai-generation.repository.js';
import type { WinbackPrisma } from '../src/client.js';

interface AiGenerationRow {
  id: string;
  merchantId: string;
  customerId: string;
  status: 'pending' | 'completed' | 'failed';
  generatedText?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
  costMicrocents?: bigint;
  completedAt?: Date;
  failedAt?: Date;
  lastError?: string;
  // Trigger snapshot fields captured for verification:
  triggerState?: string;
  previousState?: string;
  rDays?: number;
  fCount?: number;
  mCents?: bigint;
  currency?: string;
  churnRiskScore?: number | null;
  provider?: string;
  modelId?: string;
  systemPrompt?: string;
  userPrompt?: string;
}

interface MockState {
  rows: AiGenerationRow[];
  nextId: number;
  callLog: string[];
}

function makeMockPrisma(initial: Partial<MockState> = {}) {
  const state: MockState = {
    rows: initial.rows ?? [],
    nextId: initial.nextId ?? 1,
    callLog: initial.callLog ?? [],
  };

  const aiGenerationDelegate = {
    create: vi.fn(async (args: { data: Record<string, unknown>; select?: unknown }) => {
      state.callLog.push(`aiGeneration.create data.merchantId=${String(args.data['merchantId'])}`);
      const id = `gen_${String(state.nextId)}`;
      state.nextId += 1;
      const row: AiGenerationRow = {
        id,
        merchantId: args.data['merchantId'] as string,
        customerId: args.data['customerId'] as string,
        status: 'pending',
        triggerState: args.data['triggerState'] as string,
        previousState: args.data['previousState'] as string,
        rDays: args.data['rDays'] as number,
        fCount: args.data['fCount'] as number,
        mCents: args.data['mCents'] as bigint,
        currency: args.data['currency'] as string,
        churnRiskScore: args.data['churnRiskScore'] as number | null,
        provider: args.data['provider'] as string,
        modelId: args.data['modelId'] as string,
        systemPrompt: args.data['systemPrompt'] as string,
        userPrompt: args.data['userPrompt'] as string,
      };
      state.rows.push(row);
      return { id };
    }),
    updateMany: vi.fn(
      async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        state.callLog.push(
          `aiGeneration.updateMany where=${JSON.stringify(args.where)} data.status=${String(args.data['status'])}`,
        );
        let count = 0;
        for (const row of state.rows) {
          const whereId = args.where['id'] as string | undefined;
          const whereStatus = args.where['status'] as string | undefined;
          if (whereId !== undefined && row.id !== whereId) continue;
          if (whereStatus !== undefined && row.status !== whereStatus) continue;
          Object.assign(row, args.data);
          count += 1;
        }
        return { count };
      },
    ),
  };

  const prisma = { aiGeneration: aiGenerationDelegate } as unknown as WinbackPrisma;
  return { prisma, state, aiGenerationDelegate };
}

// ===========================================================================
// createPending
// ===========================================================================

const VALID_CREATE_ARGS = {
  merchantId: 'm_1',
  customerId: 'c_1',
  triggerState: 'at_risk',
  previousState: 'active',
  rDays: 45,
  fCount: 3,
  mCents: 12500n,
  currency: 'USD',
  churnRiskScore: 0.72,
  provider: 'deepseek' as const,
  modelId: 'deepseek-v4-flash',
  systemPrompt: 'You are a winback specialist for Foo Store.',
  userPrompt: 'Generate a message for customer Alice (45 days since last order).',
};

describe('AiGenerationRepository.createPending', () => {
  it('writes a row with status=pending and every trigger-snapshot field', async () => {
    const { prisma, state, aiGenerationDelegate } = makeMockPrisma();
    const repo = new AiGenerationRepository(prisma);

    const result = await repo.createPending(VALID_CREATE_ARGS);

    expect(result).toEqual({ aiGenerationId: 'gen_1' });
    expect(aiGenerationDelegate.create.mock.calls).toHaveLength(1);
    const createCall = aiGenerationDelegate.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(createCall.data['merchantId']).toBe('m_1');
    expect(createCall.data['customerId']).toBe('c_1');
    expect(createCall.data['triggerState']).toBe('at_risk');
    expect(createCall.data['previousState']).toBe('active');
    expect(createCall.data['rDays']).toBe(45);
    expect(createCall.data['fCount']).toBe(3);
    expect(createCall.data['mCents']).toBe(12500n);
    expect(createCall.data['currency']).toBe('USD');
    expect(createCall.data['churnRiskScore']).toBe(0.72);
    expect(createCall.data['provider']).toBe('deepseek');
    expect(createCall.data['modelId']).toBe('deepseek-v4-flash');
    expect(createCall.data['systemPrompt']).toBe(VALID_CREATE_ARGS.systemPrompt);
    expect(createCall.data['userPrompt']).toBe(VALID_CREATE_ARGS.userPrompt);

    // status, completedAt, generatedText, tokens, cost MUST NOT be in
    // the create payload — schema default is 'pending'; the rest are
    // null until markCompleted. Explicit pin so a future refactor that
    // sets them at create time would fail loudly.
    expect(createCall.data).not.toHaveProperty('status');
    expect(createCall.data).not.toHaveProperty('completedAt');
    expect(createCall.data).not.toHaveProperty('generatedText');
    expect(createCall.data).not.toHaveProperty('inputTokens');
    expect(createCall.data).not.toHaveProperty('costMicrocents');

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]!.status).toBe('pending');
  });

  it('preserves BigInt precision on mCents (BigInt boundary lock)', async () => {
    const { prisma, aiGenerationDelegate } = makeMockPrisma();
    const repo = new AiGenerationRepository(prisma);

    // Value larger than Number.MAX_SAFE_INTEGER (2^53 - 1 = 9007199254740991).
    const big = 9_007_199_254_740_992n + 5n;
    await repo.createPending({ ...VALID_CREATE_ARGS, mCents: big });

    const createCall = aiGenerationDelegate.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(createCall.data['mCents']).toBe(big);
    expect(typeof createCall.data['mCents']).toBe('bigint');
  });

  it('accepts null churnRiskScore (scoring engine produced none)', async () => {
    const { prisma, aiGenerationDelegate } = makeMockPrisma();
    const repo = new AiGenerationRepository(prisma);

    await repo.createPending({ ...VALID_CREATE_ARGS, churnRiskScore: null });

    const createCall = aiGenerationDelegate.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(createCall.data['churnRiskScore']).toBeNull();
  });

  it('uses the passed-in tx when provided', async () => {
    const { prisma: defaultPrisma } = makeMockPrisma();
    const tx = makeMockPrisma();
    const repo = new AiGenerationRepository(defaultPrisma);

    await repo.createPending(VALID_CREATE_ARGS, tx.prisma as never);

    expect(tx.aiGenerationDelegate.create.mock.calls).toHaveLength(1);
    expect(
      (defaultPrisma.aiGeneration as unknown as { create: { mock: { calls: unknown[] } } })
        .create.mock.calls,
    ).toHaveLength(0);
  });
});

// ===========================================================================
// markCompleted
// ===========================================================================

const VALID_COMPLETED_ARGS = {
  aiGenerationId: 'gen_1',
  generatedText: 'Hi Alice — we miss you! Use code FOO20 for 20% off.',
  inputTokens: 250,
  outputTokens: 80,
  totalTokens: 330,
  latencyMs: 1450,
  costMicrocents: 4_620n,
};

describe('AiGenerationRepository.markCompleted', () => {
  it('mutates pending row to completed + writes all response fields + completedAt', async () => {
    const { prisma, state } = makeMockPrisma({
      rows: [{ id: 'gen_1', merchantId: 'm_1', customerId: 'c_1', status: 'pending' }],
    });
    const repo = new AiGenerationRepository(prisma);

    const before = Date.now();
    const result = await repo.markCompleted(VALID_COMPLETED_ARGS);
    const after = Date.now();

    expect(result).toEqual({ updatedCount: 1 });
    const row = state.rows[0]!;
    expect(row.status).toBe('completed');
    expect(row.generatedText).toBe(VALID_COMPLETED_ARGS.generatedText);
    expect(row.inputTokens).toBe(250);
    expect(row.outputTokens).toBe(80);
    expect(row.totalTokens).toBe(330);
    expect(row.latencyMs).toBe(1450);
    expect(row.costMicrocents).toBe(4_620n);
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(row.completedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.completedAt!.getTime()).toBeLessThanOrEqual(after);
  });

  it('is idempotent — second call on already-completed row returns updatedCount: 0', async () => {
    const { prisma, state, aiGenerationDelegate } = makeMockPrisma({
      rows: [
        { id: 'gen_1', merchantId: 'm_1', customerId: 'c_1', status: 'pending' },
      ],
    });
    const repo = new AiGenerationRepository(prisma);

    const first = await repo.markCompleted(VALID_COMPLETED_ARGS);
    expect(first.updatedCount).toBe(1);

    const second = await repo.markCompleted({
      ...VALID_COMPLETED_ARGS,
      // Different cost — confirms the second call doesn't overwrite either way.
      costMicrocents: 999_999n,
    });
    expect(second.updatedCount).toBe(0);
    // First call's cost preserved — not overwritten.
    expect(state.rows[0]!.costMicrocents).toBe(4_620n);

    // BOTH calls filtered on status='pending' — the regression lock.
    for (const call of aiGenerationDelegate.updateMany.mock.calls) {
      const where = (call[0] as { where: Record<string, unknown> }).where;
      expect(where['status']).toBe('pending');
    }
  });

  it('uses the passed-in tx when provided', async () => {
    const { prisma: defaultPrisma } = makeMockPrisma({
      rows: [{ id: 'gen_1', merchantId: 'm_1', customerId: 'c_1', status: 'pending' }],
    });
    const tx = makeMockPrisma({
      rows: [{ id: 'gen_1', merchantId: 'm_1', customerId: 'c_1', status: 'pending' }],
    });
    const repo = new AiGenerationRepository(defaultPrisma);

    await repo.markCompleted(VALID_COMPLETED_ARGS, tx.prisma as never);

    expect(tx.aiGenerationDelegate.updateMany.mock.calls).toHaveLength(1);
    expect(
      (defaultPrisma.aiGeneration as unknown as { updateMany: { mock: { calls: unknown[] } } })
        .updateMany.mock.calls,
    ).toHaveLength(0);
  });
});

// ===========================================================================
// markFailed
// ===========================================================================

describe('AiGenerationRepository.markFailed', () => {
  it('mutates pending row to failed + writes lastError + failedAt', async () => {
    const { prisma, state } = makeMockPrisma({
      rows: [{ id: 'gen_1', merchantId: 'm_1', customerId: 'c_1', status: 'pending' }],
    });
    const repo = new AiGenerationRepository(prisma);

    const before = Date.now();
    const result = await repo.markFailed({
      aiGenerationId: 'gen_1',
      lastError: 'content_filter',
    });
    const after = Date.now();

    expect(result).toEqual({ updatedCount: 1 });
    const row = state.rows[0]!;
    expect(row.status).toBe('failed');
    expect(row.lastError).toBe('content_filter');
    expect(row.failedAt).toBeInstanceOf(Date);
    expect(row.failedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.failedAt!.getTime()).toBeLessThanOrEqual(after);
  });

  it('truncates lastError to 1000 characters', async () => {
    const { prisma, state } = makeMockPrisma({
      rows: [{ id: 'gen_1', merchantId: 'm_1', customerId: 'c_1', status: 'pending' }],
    });
    const repo = new AiGenerationRepository(prisma);

    // 1500-char message (e.g. provider returned a full stack trace).
    const longMessage = 'X'.repeat(1500);
    await repo.markFailed({ aiGenerationId: 'gen_1', lastError: longMessage });

    expect(state.rows[0]!.lastError).toHaveLength(1000);
    expect(state.rows[0]!.lastError).toBe('X'.repeat(1000));
  });

  it('does NOT truncate when message is exactly at the cap', async () => {
    const { prisma, state } = makeMockPrisma({
      rows: [{ id: 'gen_1', merchantId: 'm_1', customerId: 'c_1', status: 'pending' }],
    });
    const repo = new AiGenerationRepository(prisma);

    const atCap = 'Y'.repeat(1000);
    await repo.markFailed({ aiGenerationId: 'gen_1', lastError: atCap });

    expect(state.rows[0]!.lastError).toBe(atCap);
    expect(state.rows[0]!.lastError).toHaveLength(1000);
  });

  it('is idempotent — second call on already-failed row returns updatedCount: 0', async () => {
    const { prisma, state, aiGenerationDelegate } = makeMockPrisma({
      rows: [{ id: 'gen_1', merchantId: 'm_1', customerId: 'c_1', status: 'pending' }],
    });
    const repo = new AiGenerationRepository(prisma);

    const first = await repo.markFailed({
      aiGenerationId: 'gen_1',
      lastError: 'first_error',
    });
    expect(first.updatedCount).toBe(1);

    const second = await repo.markFailed({
      aiGenerationId: 'gen_1',
      lastError: 'second_error',
    });
    expect(second.updatedCount).toBe(0);
    // First call's error preserved — not overwritten by second call.
    expect(state.rows[0]!.lastError).toBe('first_error');

    // Both calls filtered on status='pending'.
    for (const call of aiGenerationDelegate.updateMany.mock.calls) {
      const where = (call[0] as { where: Record<string, unknown> }).where;
      expect(where['status']).toBe('pending');
    }
  });

  it('uses the passed-in tx when provided', async () => {
    const { prisma: defaultPrisma } = makeMockPrisma({
      rows: [{ id: 'gen_1', merchantId: 'm_1', customerId: 'c_1', status: 'pending' }],
    });
    const tx = makeMockPrisma({
      rows: [{ id: 'gen_1', merchantId: 'm_1', customerId: 'c_1', status: 'pending' }],
    });
    const repo = new AiGenerationRepository(defaultPrisma);

    await repo.markFailed(
      { aiGenerationId: 'gen_1', lastError: 'oops' },
      tx.prisma as never,
    );

    expect(tx.aiGenerationDelegate.updateMany.mock.calls).toHaveLength(1);
    expect(
      (defaultPrisma.aiGeneration as unknown as { updateMany: { mock: { calls: unknown[] } } })
        .updateMany.mock.calls,
    ).toHaveLength(0);
  });
});
