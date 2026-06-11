/**
 * Unit tests for the dispatch Worker (Epic G batch 8.2) —
 * `processCampaignDispatchJob` + `createDispatchWorker` factory.
 *
 * Real-repository + mocked-Prisma pattern (mirrors ai-generate.worker.test.ts):
 * the real `CampaignRepository.claimTarget` runs against a Prisma
 * `campaignTarget.create` delegate mock, so the test catches the
 * payload → repo args → Prisma call shape AND the P2002 → already_claimed
 * idempotency mapping. `withTenantScope` is the REAL one (no DB; just an ALS
 * context), so the worker's scope wrapping is exercised end-to-end.
 *
 * Invariants locked:
 *   - happy claim: claimTarget called with the payload's 4 ids; create gets the
 *     pending-default data; resolves.
 *   - already_claimed: a P2002 from create is a no-op (no throw) — the
 *     idempotency backstop.
 *   - real fault: a non-P2002 error re-throws to BullMQ (retryable).
 *   - factory: QUEUE_NAMES.campaign.dispatch, concurrency=1, lockDuration=1min,
 *     connection 'worker.campaign-dispatch'.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks (before imports)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { Prisma } from '@prisma/client';
import { CAMPAIGN_DISPATCH_JOB_NAME, QUEUE_NAMES } from '@winback/contracts';
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

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const PAYLOAD: CampaignDispatchJobPayload = {
  merchantId: 'm_1',
  messageId: 'msg_1',
  campaignId: 'camp_1',
  customerId: 'cust_1',
};

function makeCtx(createMock: Mock): DrainerContext {
  return {
    prisma: { campaignTarget: { create: createMock } } as unknown as WinbackPrisma,
    queues: {} as DrainerContext['queues'],
    shopifyConfig: {} as unknown as ShopifyConfig,
  };
}

function makeJob(data: CampaignDispatchJobPayload): Job<CampaignDispatchJobPayload> {
  return { id: 'job_1', data } as unknown as Job<CampaignDispatchJobPayload>;
}

beforeEach(() => {
  workerConstructorCalls.length = 0;
  vi.clearAllMocks();
});

// ===========================================================================
// processCampaignDispatchJob
// ===========================================================================

describe('processCampaignDispatchJob', () => {
  it('claims the draft — creates a pending CampaignTarget with the payload ids', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'ct_1' });
    const ctx = makeCtx(create);

    await expect(processCampaignDispatchJob(ctx, makeJob(PAYLOAD))).resolves.toBeUndefined();

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        merchantId: 'm_1',
        campaignId: 'camp_1',
        messageId: 'msg_1',
        customerId: 'cust_1',
      },
    });
  });

  it('is a no-op on a P2002 messageId-unique collision (already claimed — idempotent replay/race)', async () => {
    const create = vi.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.22.0',
      }),
    );
    const ctx = makeCtx(create);

    await expect(processCampaignDispatchJob(ctx, makeJob(PAYLOAD))).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('re-throws a non-P2002 error to BullMQ (transient fault is retryable, not swallowed)', async () => {
    const create = vi.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Deadlock', {
        code: 'P2034',
        clientVersion: '5.22.0',
      }),
    );
    const ctx = makeCtx(create);

    await expect(
      processCampaignDispatchJob(ctx, makeJob(PAYLOAD)),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });
});

// ===========================================================================
// createDispatchWorker (factory)
// ===========================================================================

describe('createDispatchWorker', () => {
  it('constructs a Worker on campaign.dispatch with concurrency=1, lockDuration=1min, own connection', () => {
    const ctx = makeCtx(vi.fn());

    createDispatchWorker(ctx);

    // Own ioredis connection (BullMQ blocking-commands rule).
    expect(vi.mocked(createRedisClient)).toHaveBeenCalledWith('worker.campaign-dispatch');

    expect(workerConstructorCalls).toHaveLength(1);
    const call = workerConstructorCalls[0]!;
    expect(call.name).toBe(QUEUE_NAMES.campaign.dispatch);
    expect(call.opts.connection).toBe(fakeRedisClient);
    expect(call.opts.concurrency).toBe(1);
    expect(call.opts.lockDuration).toBe(60 * 1000);
  });
});

// Touch the imported job-name constant so a future rename surfaces here too.
void CAMPAIGN_DISPATCH_JOB_NAME;
