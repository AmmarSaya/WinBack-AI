/**
 * Unit tests for the dispatch Worker (Epic G batch 8.3) —
 * `processCampaignDispatchJob` + `createDispatchWorker`.
 *
 * 8.3 turns the worker from claim-only into claim → replay-guard → gate-chain →
 * apply-outcome. The repos + the gate chain are mocked at the module boundary;
 * the real gate logic is unit-tested in `dispatch/gate-chain.test.ts` and the
 * real DB ops against Postgres in the db integration suite. Here we lock the
 * worker's ORCHESTRATION:
 *   - claim is called (idempotent; result discarded);
 *   - REPLAY GUARD: a terminal target does NO gate work (no runGateChain);
 *   - null context → no-op;
 *   - each gate outcome maps to the right write (resolveTerminal / deferTarget /
 *     passed send-stub).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const workerConstructorCalls: {
  name: string;
  opts: { connection: unknown; concurrency: number; lockDuration: number };
}[] = [];

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation((name: string, _processor, opts) => {
    workerConstructorCalls.push({ name, opts });
    return {
      on: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- deliberate no-op close stub
      close: vi.fn(async () => {}),
    };
  }),
}));

const fakeRedisClient = { __fakeRedis: true } as const;
vi.mock('@winback/queue', () => ({
  createRedisClient: vi.fn(() => fakeRedisClient),
}));

const m = vi.hoisted(() => ({
  claimTarget: vi.fn(),
  loadDispatchContext: vi.fn(),
  resolveTerminal: vi.fn(),
  deferTarget: vi.fn(),
  runGateChain: vi.fn(),
}));

vi.mock('@winback/db', async () => {
  const actual = await vi.importActual<typeof import('@winback/db')>('@winback/db');
  return {
    ...actual,
    withTenantScope: vi.fn(async (_merchantId: unknown, cb: () => Promise<unknown>) => cb()),
    CampaignRepository: vi.fn().mockImplementation(() => ({
      claimTarget: m.claimTarget,
      loadDispatchContext: m.loadDispatchContext,
      resolveTerminal: m.resolveTerminal,
      deferTarget: m.deferTarget,
    })),
    OrderRepository: vi.fn().mockImplementation(() => ({})),
    MessageRepository: vi.fn().mockImplementation(() => ({})),
  };
});

vi.mock('../../src/dispatch/gate-chain.js', () => ({ runGateChain: m.runGateChain }));

import { QUEUE_NAMES } from '@winback/contracts';
import type { CampaignDispatchJobPayload } from '@winback/contracts';
import type { WinbackPrisma } from '@winback/db';
import { createRedisClient } from '@winback/queue';
import type { ShopifyConfig } from '@winback/shopify';
import type { Job } from 'bullmq';

import type { DrainerContext } from '../../src/context.js';
import {
  createDispatchWorker,
  processCampaignDispatchJob,
} from '../../src/workers/dispatch.worker.js';

const PAYLOAD: CampaignDispatchJobPayload = {
  merchantId: 'm_1',
  messageId: 'msg_1',
  campaignId: 'camp_1',
  customerId: 'cust_1',
};

const CTX: DrainerContext = {
  prisma: {} as unknown as WinbackPrisma,
  queues: {} as DrainerContext['queues'],
  shopifyConfig: {} as unknown as ShopifyConfig,
};

function makeJob(): Job<CampaignDispatchJobPayload> {
  return { id: 'job_1', data: PAYLOAD } as unknown as Job<CampaignDispatchJobPayload>;
}

const PENDING_CTX = { targetStatus: 'pending', customerId: 'cust_1' };

beforeEach(() => {
  workerConstructorCalls.length = 0;
  vi.clearAllMocks();
  m.claimTarget.mockResolvedValue('claimed');
  m.loadDispatchContext.mockResolvedValue(PENDING_CTX);
  m.resolveTerminal.mockResolvedValue({ resolved: true });
  m.deferTarget.mockResolvedValue({ deferred: true });
});

describe('processCampaignDispatchJob — claim + context', () => {
  it('always claims (idempotent) then loads the dispatch context', async () => {
    m.runGateChain.mockResolvedValue({ kind: 'passed' });
    await processCampaignDispatchJob(CTX, makeJob());

    expect(m.claimTarget).toHaveBeenCalledWith({
      merchantId: 'm_1',
      campaignId: 'camp_1',
      messageId: 'msg_1',
      customerId: 'cust_1',
    });
    expect(m.loadDispatchContext).toHaveBeenCalledWith({ messageId: 'msg_1' });
  });

  it('null context (target gone / redact cascade) → no-op, NO gate work', async () => {
    m.loadDispatchContext.mockResolvedValue(null);
    await processCampaignDispatchJob(CTX, makeJob());

    expect(m.runGateChain).not.toHaveBeenCalled();
    expect(m.resolveTerminal).not.toHaveBeenCalled();
    expect(m.deferTarget).not.toHaveBeenCalled();
  });

  it('REPLAY GUARD: a terminal target (suppressed) does NO gate work — runGateChain never called', async () => {
    m.loadDispatchContext.mockResolvedValue({ targetStatus: 'suppressed', customerId: 'cust_1' });
    await processCampaignDispatchJob(CTX, makeJob());

    // claim still ran (idempotent), but the guard short-circuited before gates.
    expect(m.claimTarget).toHaveBeenCalledTimes(1);
    expect(m.runGateChain).not.toHaveBeenCalled();
    expect(m.resolveTerminal).not.toHaveBeenCalled();
    expect(m.deferTarget).not.toHaveBeenCalled();
  });

  it.each(['sent', 'failed'])('REPLAY GUARD: terminal status %s short-circuits too', async (status) => {
    m.loadDispatchContext.mockResolvedValue({ targetStatus: status, customerId: 'cust_1' });
    await processCampaignDispatchJob(CTX, makeJob());
    expect(m.runGateChain).not.toHaveBeenCalled();
  });
});

describe('processCampaignDispatchJob — outcome application', () => {
  it('suppressed(gate) → resolveTerminal({messageId, reason: gate}); deferTarget NOT called', async () => {
    m.runGateChain.mockResolvedValue({ kind: 'suppressed', gate: 'consent' });
    await processCampaignDispatchJob(CTX, makeJob());

    expect(m.resolveTerminal).toHaveBeenCalledWith({ messageId: 'msg_1', reason: 'consent' });
    expect(m.deferTarget).not.toHaveBeenCalled();
  });

  it('deferred(gate) → deferTarget({messageId}); resolveTerminal NOT called', async () => {
    m.runGateChain.mockResolvedValue({ kind: 'deferred', gate: 'quiet_hours' });
    await processCampaignDispatchJob(CTX, makeJob());

    expect(m.deferTarget).toHaveBeenCalledWith({ messageId: 'msg_1' });
    expect(m.resolveTerminal).not.toHaveBeenCalled();
  });

  it('passed → send-stub (NO resolveTerminal, NO deferTarget; target left pending)', async () => {
    m.runGateChain.mockResolvedValue({ kind: 'passed' });
    await processCampaignDispatchJob(CTX, makeJob());

    expect(m.resolveTerminal).not.toHaveBeenCalled();
    expect(m.deferTarget).not.toHaveBeenCalled();
  });
});

describe('createDispatchWorker (factory)', () => {
  it('constructs a Worker on campaign.dispatch with concurrency=1, lockDuration=1min, own connection', () => {
    createDispatchWorker(CTX);

    expect(vi.mocked(createRedisClient)).toHaveBeenCalledWith('worker.campaign-dispatch');
    expect(workerConstructorCalls).toHaveLength(1);
    const call = workerConstructorCalls[0]!;
    expect(call.name).toBe(QUEUE_NAMES.campaign.dispatch);
    expect(call.opts.connection).toBe(fakeRedisClient);
    expect(call.opts.concurrency).toBe(1);
    expect(call.opts.lockDuration).toBe(60 * 1000);
  });
});
