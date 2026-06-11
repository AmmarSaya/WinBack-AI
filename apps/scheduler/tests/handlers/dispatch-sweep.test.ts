/**
 * Unit tests for runDispatchSweep (Epic G batch 8.2 — the dispatch tick).
 *
 * Covers:
 *   - the cross-tenant SELECT for live merchants with active email campaigns
 *   - per-merchant `findDispatchableDrafts` runs under `withTenantScope`
 *   - one `campaign.dispatch` job per eligible draft, via addBulk, with the
 *     right payload + retry opts
 *   - a merchant with zero eligible drafts enqueues nothing (no empty addBulk)
 *   - per-merchant try/catch (one failure doesn't terminate the sweep)
 *   - empty merchant SELECT short-circuits
 *   - the whole sweep runs under withSystemScope('campaign.dispatch_sweep')
 *
 * `@winback/db`'s `CampaignRepository` + scope helpers are mocked at the module
 * boundary; the real pickup SQL is proven against real Postgres in
 * `packages/db/tests/integration/campaign-dispatch.test.ts`.
 */

import { CAMPAIGN_DISPATCH_JOB_NAME } from '@winback/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SchedulerContext } from '../../src/context.js';

const { findDispatchableDraftsMock } = vi.hoisted(() => ({
  findDispatchableDraftsMock: vi.fn(),
}));

vi.mock('@winback/db', async () => {
  const actual = await vi.importActual<typeof import('@winback/db')>('@winback/db');
  return {
    ...actual,
    // Pass-through scope wrappers — run the callback directly so the handler's
    // control flow is exercised without AsyncLocalStorage setup.
    withSystemScope: vi.fn(async (_reason: unknown, cb: () => Promise<unknown>) => cb()),
    withTenantScope: vi.fn(async (_merchantId: unknown, cb: () => Promise<unknown>) => cb()),
    CampaignRepository: vi.fn().mockImplementation(() => ({
      findDispatchableDrafts: findDispatchableDraftsMock,
    })),
  };
});

const dbMod = await import('@winback/db');
const { runDispatchSweep } = await import('../../src/handlers/dispatch-sweep.js');

interface MockedPrisma {
  $queryRaw: ReturnType<typeof vi.fn>;
}

function makeCtx(
  prisma: MockedPrisma,
  addBulk: ReturnType<typeof vi.fn>,
): SchedulerContext {
  return {
    prisma: prisma as unknown as SchedulerContext['prisma'],
    queues: { campaignDispatch: { addBulk } } as unknown as SchedulerContext['queues'],
    shopifyConfig: {} as unknown as SchedulerContext['shopifyConfig'],
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('runDispatchSweep — happy path', () => {
  it('selects merchants, picks up drafts per merchant under tenant scope, enqueues one job per draft', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{ id: 'm-1' }, { id: 'm-2' }]);
    findDispatchableDraftsMock
      .mockResolvedValueOnce([
        { messageId: 'msg-1', customerId: 'c-1', campaignId: 'camp-1' },
        { messageId: 'msg-2', customerId: 'c-2', campaignId: 'camp-1' },
      ])
      .mockResolvedValueOnce([{ messageId: 'msg-3', customerId: 'c-3', campaignId: 'camp-9' }]);
    const addBulk = vi.fn().mockResolvedValue([]);

    await runDispatchSweep(makeCtx({ $queryRaw: queryRaw }, addBulk));

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(findDispatchableDraftsMock).toHaveBeenCalledTimes(2);
    // Each pickup wrapped in withTenantScope(merchantId, ...).
    expect(vi.mocked(dbMod.withTenantScope).mock.calls.map((c) => c[0])).toEqual(['m-1', 'm-2']);

    // One addBulk per merchant (both had drafts).
    expect(addBulk).toHaveBeenCalledTimes(2);
    // Merchant 1's batch — per-draft jobs with the canonical name + payload + retry opts.
    expect(addBulk.mock.calls[0]![0]).toEqual([
      {
        name: CAMPAIGN_DISPATCH_JOB_NAME,
        data: { merchantId: 'm-1', messageId: 'msg-1', campaignId: 'camp-1', customerId: 'c-1' },
        opts: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
      },
      {
        name: CAMPAIGN_DISPATCH_JOB_NAME,
        data: { merchantId: 'm-1', messageId: 'msg-2', campaignId: 'camp-1', customerId: 'c-2' },
        opts: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
      },
    ]);
  });

  it('a merchant with zero eligible drafts enqueues nothing (no empty addBulk)', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{ id: 'm-1' }]);
    findDispatchableDraftsMock.mockResolvedValueOnce([]);
    const addBulk = vi.fn().mockResolvedValue([]);

    await runDispatchSweep(makeCtx({ $queryRaw: queryRaw }, addBulk));

    expect(findDispatchableDraftsMock).toHaveBeenCalledTimes(1);
    expect(addBulk).not.toHaveBeenCalled();
  });

  it('empty merchant SELECT short-circuits (no pickup, no enqueue)', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([]);
    const addBulk = vi.fn().mockResolvedValue([]);

    await runDispatchSweep(makeCtx({ $queryRaw: queryRaw }, addBulk));

    expect(findDispatchableDraftsMock).not.toHaveBeenCalled();
    expect(addBulk).not.toHaveBeenCalled();
    expect(vi.mocked(dbMod.withTenantScope)).not.toHaveBeenCalled();
  });
});

describe('runDispatchSweep — failure containment', () => {
  it('one merchant pickup throw is caught; iteration continues', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'm-1' }, { id: 'm-bad' }, { id: 'm-3' }]);
    findDispatchableDraftsMock
      .mockResolvedValueOnce([{ messageId: 'msg-1', customerId: 'c-1', campaignId: 'camp-1' }])
      .mockRejectedValueOnce(new Error('pickup query failed'))
      .mockResolvedValueOnce([{ messageId: 'msg-3', customerId: 'c-3', campaignId: 'camp-3' }]);
    const addBulk = vi.fn().mockResolvedValue([]);

    await expect(
      runDispatchSweep(makeCtx({ $queryRaw: queryRaw }, addBulk)),
    ).resolves.toBeUndefined();

    expect(findDispatchableDraftsMock).toHaveBeenCalledTimes(3);
    // The two healthy merchants still enqueued; the failed one did not.
    expect(addBulk).toHaveBeenCalledTimes(2);
  });
});

describe('runDispatchSweep — scope', () => {
  it('wraps the whole sweep in withSystemScope(campaign.dispatch_sweep)', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{ id: 'm-1' }]);
    findDispatchableDraftsMock.mockResolvedValueOnce([]);
    const addBulk = vi.fn().mockResolvedValue([]);

    await runDispatchSweep(makeCtx({ $queryRaw: queryRaw }, addBulk));

    expect(vi.mocked(dbMod.withSystemScope)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dbMod.withSystemScope).mock.calls[0]![0]).toBe('campaign.dispatch_sweep');
  });
});
