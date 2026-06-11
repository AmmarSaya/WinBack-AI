/**
 * Unit tests for runDispatchSweep (Epic G batch 8.2 tick + 8.3 arm-2).
 *
 * Covers:
 *   - cross-tenant SELECT of live merchants with active email campaigns
 *   - ARM 1: per-merchant `findDispatchableDrafts` under tenant scope →
 *     one job per eligible draft
 *   - ARM 2 (8.3): `findDeferredTargets` partition — young+active → re-enqueue;
 *     stale (createdAt past MAX_DISPATCH_AGE) → resolveTerminal('deferred_stale'),
 *     no re-enqueue; paused campaign → resolveTerminal('campaign_paused'), no
 *     re-enqueue
 *   - per-merchant try/catch; empty SELECT short-circuit; system scope
 *
 * `@winback/db`'s `CampaignRepository` + scope helpers are mocked; the real
 * pickup/defer/terminal SQL is proven against real Postgres in the db
 * integration suite.
 */

import { CAMPAIGN_DISPATCH_JOB_NAME } from '@winback/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SchedulerContext } from '../../src/context.js';

const m = vi.hoisted(() => ({
  findDispatchableDrafts: vi.fn(),
  findDeferredTargets: vi.fn(),
  resolveTerminal: vi.fn(),
}));

vi.mock('@winback/db', async () => {
  const actual = await vi.importActual<typeof import('@winback/db')>('@winback/db');
  return {
    ...actual,
    withSystemScope: vi.fn(async (_reason: unknown, cb: () => Promise<unknown>) => cb()),
    withTenantScope: vi.fn(async (_merchantId: unknown, cb: () => Promise<unknown>) => cb()),
    CampaignRepository: vi.fn().mockImplementation(() => ({
      findDispatchableDrafts: m.findDispatchableDrafts,
      findDeferredTargets: m.findDeferredTargets,
      resolveTerminal: m.resolveTerminal,
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

const recent = (): Date => new Date(Date.now() - 60_000); // 1 min ago → young
const ancient = (): Date => new Date(Date.now() - 4 * 24 * 60 * 60 * 1000); // 4 days → stale

/** Pull the enqueued message ids out of an addBulk(jobs) call. */
function enqueuedMessageIds(addBulk: ReturnType<typeof vi.fn>): string[] {
  return addBulk.mock.calls.flatMap((call) =>
    (call[0] as { data: { messageId: string } }[]).map((j) => j.data.messageId),
  );
}

beforeEach(() => {
  // Defaults: no work. Tests override per-merchant via mockResolvedValueOnce.
  m.findDispatchableDrafts.mockResolvedValue([]);
  m.findDeferredTargets.mockResolvedValue([]);
  m.resolveTerminal.mockResolvedValue({ resolved: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runDispatchSweep — arm 1 (fresh drafts)', () => {
  it('enqueues one job per eligible draft, under tenant scope', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{ id: 'm-1' }, { id: 'm-2' }]);
    m.findDispatchableDrafts
      .mockResolvedValueOnce([
        { messageId: 'msg-1', customerId: 'c-1', campaignId: 'camp-1' },
        { messageId: 'msg-2', customerId: 'c-2', campaignId: 'camp-1' },
      ])
      .mockResolvedValueOnce([{ messageId: 'msg-3', customerId: 'c-3', campaignId: 'camp-9' }]);
    const addBulk = vi.fn().mockResolvedValue([]);

    await runDispatchSweep(makeCtx({ $queryRaw: queryRaw }, addBulk));

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dbMod.withTenantScope).mock.calls.map((c) => c[0])).toEqual(['m-1', 'm-2']);
    expect(enqueuedMessageIds(addBulk).sort()).toEqual(['msg-1', 'msg-2', 'msg-3']);
    expect(m.resolveTerminal).not.toHaveBeenCalled();
  });

  it('a merchant with no drafts and no deferred targets enqueues nothing', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{ id: 'm-1' }]);
    const addBulk = vi.fn().mockResolvedValue([]);

    await runDispatchSweep(makeCtx({ $queryRaw: queryRaw }, addBulk));

    expect(addBulk).not.toHaveBeenCalled();
    expect(m.resolveTerminal).not.toHaveBeenCalled();
  });

  it('empty merchant SELECT short-circuits', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([]);
    const addBulk = vi.fn().mockResolvedValue([]);

    await runDispatchSweep(makeCtx({ $queryRaw: queryRaw }, addBulk));

    expect(m.findDispatchableDrafts).not.toHaveBeenCalled();
    expect(m.findDeferredTargets).not.toHaveBeenCalled();
    expect(vi.mocked(dbMod.withTenantScope)).not.toHaveBeenCalled();
  });
});

describe('runDispatchSweep — arm 2 (deferred re-entry)', () => {
  it('young + active deferred target → re-enqueued (no terminal write)', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{ id: 'm-1' }]);
    m.findDeferredTargets.mockResolvedValueOnce([
      { messageId: 'msg-d', campaignId: 'camp-d', customerId: 'c-d', createdAt: recent(), campaignActive: true },
    ]);
    const addBulk = vi.fn().mockResolvedValue([]);

    await runDispatchSweep(makeCtx({ $queryRaw: queryRaw }, addBulk));

    expect(enqueuedMessageIds(addBulk)).toEqual(['msg-d']);
    expect(m.resolveTerminal).not.toHaveBeenCalled();
  });

  it('STALE deferred target (createdAt past MAX_DISPATCH_AGE) → expired, NOT re-enqueued', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{ id: 'm-1' }]);
    m.findDeferredTargets.mockResolvedValueOnce([
      { messageId: 'msg-stale', campaignId: 'camp-d', customerId: 'c-d', createdAt: ancient(), campaignActive: true },
    ]);
    const addBulk = vi.fn().mockResolvedValue([]);

    await runDispatchSweep(makeCtx({ $queryRaw: queryRaw }, addBulk));

    expect(m.resolveTerminal).toHaveBeenCalledWith({ messageId: 'msg-stale', reason: 'deferred_stale' });
    expect(addBulk).not.toHaveBeenCalled();
  });

  it('PAUSED-campaign deferred target → resolved, NOT re-enqueued', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{ id: 'm-1' }]);
    m.findDeferredTargets.mockResolvedValueOnce([
      { messageId: 'msg-paused', campaignId: 'camp-d', customerId: 'c-d', createdAt: recent(), campaignActive: false },
    ]);
    const addBulk = vi.fn().mockResolvedValue([]);

    await runDispatchSweep(makeCtx({ $queryRaw: queryRaw }, addBulk));

    expect(m.resolveTerminal).toHaveBeenCalledWith({ messageId: 'msg-paused', reason: 'campaign_paused' });
    expect(addBulk).not.toHaveBeenCalled();
  });

  it('mixed batch: a draft + young + stale + paused → enqueue {draft, young}, resolve {stale, paused}', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{ id: 'm-1' }]);
    m.findDispatchableDrafts.mockResolvedValueOnce([
      { messageId: 'msg-draft', customerId: 'c-1', campaignId: 'camp-1' },
    ]);
    m.findDeferredTargets.mockResolvedValueOnce([
      { messageId: 'msg-young', campaignId: 'camp-d', customerId: 'c-d', createdAt: recent(), campaignActive: true },
      { messageId: 'msg-stale', campaignId: 'camp-d', customerId: 'c-d', createdAt: ancient(), campaignActive: true },
      { messageId: 'msg-paused', campaignId: 'camp-d', customerId: 'c-d', createdAt: recent(), campaignActive: false },
    ]);
    const addBulk = vi.fn().mockResolvedValue([]);

    await runDispatchSweep(makeCtx({ $queryRaw: queryRaw }, addBulk));

    expect(enqueuedMessageIds(addBulk).sort()).toEqual(['msg-draft', 'msg-young']);
    expect(m.resolveTerminal.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([
        { messageId: 'msg-stale', reason: 'deferred_stale' },
        { messageId: 'msg-paused', reason: 'campaign_paused' },
      ]),
    );
    expect(m.resolveTerminal).toHaveBeenCalledTimes(2);
  });
});

describe('runDispatchSweep — containment + scope', () => {
  it('one merchant pickup throw is caught; iteration continues', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'm-1' }, { id: 'm-bad' }, { id: 'm-3' }]);
    m.findDispatchableDrafts
      .mockResolvedValueOnce([{ messageId: 'msg-1', customerId: 'c-1', campaignId: 'camp-1' }])
      .mockRejectedValueOnce(new Error('pickup query failed'))
      .mockResolvedValueOnce([{ messageId: 'msg-3', customerId: 'c-3', campaignId: 'camp-3' }]);
    const addBulk = vi.fn().mockResolvedValue([]);

    await expect(
      runDispatchSweep(makeCtx({ $queryRaw: queryRaw }, addBulk)),
    ).resolves.toBeUndefined();

    expect(enqueuedMessageIds(addBulk).sort()).toEqual(['msg-1', 'msg-3']);
  });

  it('wraps the whole sweep in withSystemScope(campaign.dispatch_sweep)', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{ id: 'm-1' }]);
    const addBulk = vi.fn().mockResolvedValue([]);

    await runDispatchSweep(makeCtx({ $queryRaw: queryRaw }, addBulk));

    expect(vi.mocked(dbMod.withSystemScope)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dbMod.withSystemScope).mock.calls[0]![0]).toBe('campaign.dispatch_sweep');
  });
});

// Touch the imported constant so a rename surfaces here too.
void CAMPAIGN_DISPATCH_JOB_NAME;
