/**
 * Unit tests for MessageRepository.
 *
 * Mocked-Prisma pattern (same shape as
 * ai-generation-repository.test.ts / merchant-repository.test.ts).
 * Exercises the repository's control flow + arg shapes: that
 * createDraft writes status=draft + empty generatedText, that
 * updateGeneratedText keys by aiGenerationId (not messageId), and
 * that both methods honor the optional `tx` parameter. Tenant-scope
 * extension behaviour is covered by tenant-scope.test.ts + the
 * integration smoke.
 */

import { describe, expect, it, vi } from 'vitest';

import { MessageRepository } from '../src/repositories/message.repository.js';
import type { WinbackPrisma } from '../src/client.js';

interface MessageRow {
  id: string;
  merchantId: string;
  customerId: string;
  aiGenerationId: string;
  generatedText: string;
  status: 'draft';
}

interface MockState {
  rows: MessageRow[];
  nextId: number;
  callLog: string[];
}

function makeMockPrisma(initial: Partial<MockState> = {}) {
  const state: MockState = {
    rows: initial.rows ?? [],
    nextId: initial.nextId ?? 1,
    callLog: initial.callLog ?? [],
  };

  const messageDelegate = {
    create: vi.fn(async (args: { data: Record<string, unknown>; select?: unknown }) => {
      state.callLog.push(
        `message.create merchantId=${String(args.data['merchantId'])} aiGenerationId=${String(args.data['aiGenerationId'])}`,
      );
      const id = `msg_${String(state.nextId)}`;
      state.nextId += 1;
      const row: MessageRow = {
        id,
        merchantId: args.data['merchantId'] as string,
        customerId: args.data['customerId'] as string,
        aiGenerationId: args.data['aiGenerationId'] as string,
        generatedText: args.data['generatedText'] as string,
        status: 'draft',
      };
      state.rows.push(row);
      return { id };
    }),
    updateMany: vi.fn(
      async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        state.callLog.push(
          `message.updateMany where=${JSON.stringify(args.where)}`,
        );
        let count = 0;
        for (const row of state.rows) {
          const whereGenId = args.where['aiGenerationId'] as string | undefined;
          if (whereGenId !== undefined && row.aiGenerationId !== whereGenId) continue;
          Object.assign(row, args.data);
          count += 1;
        }
        return { count };
      },
    ),
  };

  const prisma = { message: messageDelegate } as unknown as WinbackPrisma;
  return { prisma, state, messageDelegate };
}

// ===========================================================================
// createDraft
// ===========================================================================

describe('MessageRepository.createDraft', () => {
  it('writes a row with status=draft, empty generatedText, and the aiGenerationId', async () => {
    const { prisma, state, messageDelegate } = makeMockPrisma();
    const repo = new MessageRepository(prisma);

    const result = await repo.createDraft({
      merchantId: 'm_1',
      customerId: 'c_1',
      aiGenerationId: 'gen_1',
    });

    expect(result).toEqual({ messageId: 'msg_1' });
    expect(messageDelegate.create.mock.calls).toHaveLength(1);
    const createCall = messageDelegate.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(createCall.data['merchantId']).toBe('m_1');
    expect(createCall.data['customerId']).toBe('c_1');
    expect(createCall.data['aiGenerationId']).toBe('gen_1');
    expect(createCall.data['generatedText']).toBe('');

    // status NOT in the create payload — schema default is 'draft'.
    // Explicit pin so a future refactor that hardcodes the status
    // value would surface in this test.
    expect(createCall.data).not.toHaveProperty('status');

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]!.status).toBe('draft');
    expect(state.rows[0]!.generatedText).toBe('');
  });

  it('uses the passed-in tx when provided (sibling-call atomicity with createPending)', async () => {
    // The §F-Q7 atomicity lock: createDraft is called inside the same
    // tx as AiGenerationRepository.createPending in the drainer's
    // handleCustomerStateChanged. The tx parameter is the load-
    // bearing piece of that contract.
    const { prisma: defaultPrisma } = makeMockPrisma();
    const tx = makeMockPrisma();
    const repo = new MessageRepository(defaultPrisma);

    await repo.createDraft(
      { merchantId: 'm_1', customerId: 'c_1', aiGenerationId: 'gen_1' },
      tx.prisma as never,
    );

    expect(tx.messageDelegate.create.mock.calls).toHaveLength(1);
    expect(
      (defaultPrisma.message as unknown as { create: { mock: { calls: unknown[] } } })
        .create.mock.calls,
    ).toHaveLength(0);
  });
});

// ===========================================================================
// updateGeneratedText
// ===========================================================================

describe('MessageRepository.updateGeneratedText', () => {
  it('updates the row keyed by aiGenerationId (NOT messageId) and writes generatedText', async () => {
    // The §F-5 / §F-9 contract: the AI Worker holds the AiGeneration
    // row reference (not the Message row reference) when it completes.
    // The repository MUST key by aiGenerationId via the global @unique.
    const { prisma, state, messageDelegate } = makeMockPrisma({
      rows: [
        {
          id: 'msg_1',
          merchantId: 'm_1',
          customerId: 'c_1',
          aiGenerationId: 'gen_1',
          generatedText: '',
          status: 'draft',
        },
      ],
    });
    const repo = new MessageRepository(prisma);

    const text = 'Hi Alice — we miss you! Use code FOO20 for 20% off.';
    const result = await repo.updateGeneratedText({
      aiGenerationId: 'gen_1',
      generatedText: text,
    });

    expect(result).toEqual({ updatedCount: 1 });

    // The where clause MUST be keyed on aiGenerationId, NOT on id
    // (messageId). Regression lock.
    const updateCall = messageDelegate.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(updateCall.where).toEqual({ aiGenerationId: 'gen_1' });
    expect(updateCall.where).not.toHaveProperty('id');
    expect(updateCall.data['generatedText']).toBe(text);

    expect(state.rows[0]!.generatedText).toBe(text);
  });

  it('returns updatedCount: 0 when no row matches the aiGenerationId', async () => {
    // Edge case: AiGeneration was redacted between the drainer's
    // createDraft and the AI Worker's updateGeneratedText (cascade
    // delete chain from a customers/redact event). The Worker should
    // see updatedCount: 0 and handle it gracefully (likely log + skip).
    const { prisma } = makeMockPrisma();
    const repo = new MessageRepository(prisma);

    const result = await repo.updateGeneratedText({
      aiGenerationId: 'gen_does_not_exist',
      generatedText: 'orphan text',
    });

    expect(result).toEqual({ updatedCount: 0 });
  });

  it('idempotent — second call with the same text returns updatedCount: 1 again, row content unchanged', async () => {
    // No status-filter idempotency pattern (unlike AiGeneration's
    // markCompleted). The repository overwrites the same value;
    // the invariant is "Message.generatedText equals the most-
    // recently-written AiGeneration.generatedText for that
    // aiGenerationId," which holds across repeats.
    const { prisma, state } = makeMockPrisma({
      rows: [
        {
          id: 'msg_1',
          merchantId: 'm_1',
          customerId: 'c_1',
          aiGenerationId: 'gen_1',
          generatedText: '',
          status: 'draft',
        },
      ],
    });
    const repo = new MessageRepository(prisma);

    const text = 'the canonical text';
    const first = await repo.updateGeneratedText({
      aiGenerationId: 'gen_1',
      generatedText: text,
    });
    const second = await repo.updateGeneratedText({
      aiGenerationId: 'gen_1',
      generatedText: text,
    });

    expect(first.updatedCount).toBe(1);
    expect(second.updatedCount).toBe(1);
    expect(state.rows[0]!.generatedText).toBe(text);
  });

  it('uses the passed-in tx (joins AI Worker completion tx)', async () => {
    // The completion-time three-write atomicity: AiGeneration.
    // markCompleted + Message.updateGeneratedText + AiSpendBucket.
    // incrementSpend all share the same tx. This test pins the
    // load-bearing part: updateGeneratedText respects the tx.
    const { prisma: defaultPrisma } = makeMockPrisma({
      rows: [
        {
          id: 'msg_1',
          merchantId: 'm_1',
          customerId: 'c_1',
          aiGenerationId: 'gen_1',
          generatedText: '',
          status: 'draft',
        },
      ],
    });
    const tx = makeMockPrisma({
      rows: [
        {
          id: 'msg_1',
          merchantId: 'm_1',
          customerId: 'c_1',
          aiGenerationId: 'gen_1',
          generatedText: '',
          status: 'draft',
        },
      ],
    });
    const repo = new MessageRepository(defaultPrisma);

    await repo.updateGeneratedText(
      { aiGenerationId: 'gen_1', generatedText: 'via tx' },
      tx.prisma as never,
    );

    expect(tx.messageDelegate.updateMany.mock.calls).toHaveLength(1);
    expect(
      (defaultPrisma.message as unknown as { updateMany: { mock: { calls: unknown[] } } })
        .updateMany.mock.calls,
    ).toHaveLength(0);
  });
});
