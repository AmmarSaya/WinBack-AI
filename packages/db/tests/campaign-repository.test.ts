import { Prisma } from '@prisma/client';
import { describe, expect, it, vi, type Mock } from 'vitest';

import type { WinbackPrisma } from '../src/client.js';
import { TenantScopeError } from '../src/errors.js';
import { CampaignRepository } from '../src/repositories/campaign.repository.js';
import { withTenantScope } from '../src/tenant-scope.js';

/**
 * Unit tests for CampaignRepository (Epic G batch 8.2 — dispatch skeleton).
 *
 * Two surfaces, two mocking strategies (mirrors order-repository.test.ts):
 *
 *   - `findDispatchableDrafts` is raw SQL via `queryRawScoped` → mock
 *     `$queryRaw` and assert the WRAPPER contract (scope assertion, result
 *     passthrough). The SQL itself (DISTINCT-ON tiebreak, completed+non-empty
 *     gate, soft-delete + NOT-EXISTS filters) is exercised against real
 *     Postgres by `tests/integration/campaign-dispatch.test.ts` — same split
 *     as `findRecentPurchasedTitles` / `readCohort`.
 *
 *   - `claimTarget` is a Prisma `create` → mock `campaignTarget.create` and
 *     assert the create payload + the P2002 → `already_claimed` idempotency
 *     no-op (and that a non-P2002 error re-throws).
 */

const MERCHANT_ID = 'm_test';

describe('CampaignRepository.findDispatchableDrafts', () => {
  function makeRepo(queryRaw: Mock): CampaignRepository {
    return new CampaignRepository({ $queryRaw: queryRaw } as unknown as WinbackPrisma);
  }

  it('passes through the $queryRaw rows (messageId/customerId/campaignId)', async () => {
    const rows = [
      { messageId: 'msg_1', customerId: 'cust_1', campaignId: 'camp_old' },
      { messageId: 'msg_2', customerId: 'cust_2', campaignId: 'camp_old' },
    ];
    const queryRaw = vi.fn().mockResolvedValue(rows);
    const repo = makeRepo(queryRaw);

    const result = await withTenantScope(MERCHANT_ID, async () =>
      repo.findDispatchableDrafts({ merchantId: MERCHANT_ID }),
    );

    expect(result).toEqual(rows);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns [] when no draft is eligible (the normal idle-tick path)', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const repo = makeRepo(queryRaw);

    const result = await withTenantScope(MERCHANT_ID, async () =>
      repo.findDispatchableDrafts({ merchantId: MERCHANT_ID }),
    );

    expect(result).toEqual([]);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('asserts tenant scope BEFORE running the query — TenantScopeError on mismatch, query never runs', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const repo = makeRepo(queryRaw);

    await expect(
      withTenantScope('m_other', async () =>
        repo.findDispatchableDrafts({ merchantId: MERCHANT_ID }),
      ),
    ).rejects.toBeInstanceOf(TenantScopeError);

    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe('CampaignRepository.claimTarget', () => {
  function makeRepo(create: Mock): CampaignRepository {
    return new CampaignRepository({
      campaignTarget: { create },
    } as unknown as WinbackPrisma);
  }

  const ARGS = {
    merchantId: MERCHANT_ID,
    campaignId: 'camp_1',
    messageId: 'msg_1',
    customerId: 'cust_1',
  };

  it('creates a pending CampaignTarget and returns "claimed" on success', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'ct_1' });
    const repo = makeRepo(create);

    const result = await repo.claimTarget(ARGS);

    expect(result).toBe('claimed');
    expect(create).toHaveBeenCalledTimes(1);
    // The claim carries the explicit merchantId (extension asserts it against
    // the active scope) and leaves status to the schema default (pending).
    expect(create).toHaveBeenCalledWith({
      data: {
        merchantId: MERCHANT_ID,
        campaignId: 'camp_1',
        messageId: 'msg_1',
        customerId: 'cust_1',
      },
    });
  });

  it('returns "already_claimed" (no throw) on a P2002 messageId-unique collision — the idempotency backstop', async () => {
    const create = vi.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.22.0',
      }),
    );
    const repo = makeRepo(create);

    await expect(repo.claimTarget(ARGS)).resolves.toBe('already_claimed');
  });

  it('re-throws a non-P2002 error (real fault must not be swallowed)', async () => {
    const create = vi.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('FK violation', {
        code: 'P2003',
        clientVersion: '5.22.0',
      }),
    );
    const repo = makeRepo(create);

    await expect(repo.claimTarget(ARGS)).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
  });
});

// ===========================================================================
// Gate-chain reads (8.3)
// ===========================================================================

describe('CampaignRepository.isSuppressed', () => {
  function makeRepo(findUnique: Mock): CampaignRepository {
    return new CampaignRepository({
      suppression: { findUnique },
    } as unknown as WinbackPrisma);
  }

  it('true when a suppression row exists for (merchant, customer, channel)', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'sup_1' });
    const repo = makeRepo(findUnique);

    await expect(
      repo.isSuppressed({ merchantId: MERCHANT_ID, customerId: 'cust_1', channel: 'email' }),
    ).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        merchantId_customerId_channel: {
          merchantId: MERCHANT_ID,
          customerId: 'cust_1',
          channel: 'email',
        },
      },
      select: { id: true },
    });
  });

  it('false when no suppression row', async () => {
    const repo = makeRepo(vi.fn().mockResolvedValue(null));
    await expect(
      repo.isSuppressed({ merchantId: MERCHANT_ID, customerId: 'cust_1', channel: 'email' }),
    ).resolves.toBe(false);
  });
});

describe('CampaignRepository.getQuotaUsage', () => {
  it('reads today (UTC midnight) sentCount + the running month-sum (from UTC first-of-month)', async () => {
    const findUnique = vi.fn().mockResolvedValue({ sentCount: 7 });
    const aggregate = vi.fn().mockResolvedValue({ _sum: { sentCount: 42 } });
    const repo = new CampaignRepository({
      messageQuotaBucket: { findUnique, aggregate },
    } as unknown as WinbackPrisma);

    const now = new Date('2026-06-11T13:45:00Z');
    const result = await repo.getQuotaUsage({ merchantId: MERCHANT_ID, now });

    expect(result).toEqual({ daySentCount: 7, monthSentCount: 42 });
    // Day bucket keyed at UTC midnight of `now`.
    expect(findUnique).toHaveBeenCalledWith({
      where: { merchantId_date: { merchantId: MERCHANT_ID, date: new Date('2026-06-11T00:00:00Z') } },
      select: { sentCount: true },
    });
    // Month-sum from UTC first-of-month.
    expect(aggregate).toHaveBeenCalledWith({
      _sum: { sentCount: true },
      where: { merchantId: MERCHANT_ID, date: { gte: new Date('2026-06-01T00:00:00Z') } },
    });
  });

  it('defaults to 0/0 when there is no bucket yet', async () => {
    const repo = new CampaignRepository({
      messageQuotaBucket: {
        findUnique: vi.fn().mockResolvedValue(null),
        aggregate: vi.fn().mockResolvedValue({ _sum: { sentCount: null } }),
      },
    } as unknown as WinbackPrisma);

    await expect(
      repo.getQuotaUsage({ merchantId: MERCHANT_ID, now: new Date('2026-06-11T13:45:00Z') }),
    ).resolves.toEqual({ daySentCount: 0, monthSentCount: 0 });
  });
});

describe('CampaignRepository.loadDispatchContext', () => {
  const FULL_TARGET = {
    status: 'pending',
    customerId: 'cust_1',
    customer: { emailMarketingConsentState: 'subscribed' },
    message: { aiGeneration: { createdAt: new Date('2026-06-10T00:00:00Z') } },
    merchant: {
      timezone: 'America/Los_Angeles',
      settings: {
        sendTimeStartHour: 9,
        sendTimeEndHour: 18,
        defaultCooldownHours: 168,
        maxDailySendsPerCustomer: 1,
        dailySendCap: 2000,
        monthlySendsCap: 50000,
      },
    },
  };

  it('maps the nested read into a flat DispatchContext (incl. the replay-guard status)', async () => {
    const repo = new CampaignRepository({
      campaignTarget: { findUnique: vi.fn().mockResolvedValue(FULL_TARGET) },
    } as unknown as WinbackPrisma);

    await expect(repo.loadDispatchContext({ messageId: 'msg_1' })).resolves.toEqual({
      targetStatus: 'pending',
      customerId: 'cust_1',
      consentState: 'subscribed',
      generationCreatedAt: new Date('2026-06-10T00:00:00Z'),
      timezone: 'America/Los_Angeles',
      sendTimeStartHour: 9,
      sendTimeEndHour: 18,
      defaultCooldownHours: 168,
      maxDailySendsPerCustomer: 1,
      dailySendCap: 2000,
      monthlySendsCap: 50000,
    });
  });

  it('returns null when the target is gone (e.g. GDPR redact cascade-deleted it)', async () => {
    const repo = new CampaignRepository({
      campaignTarget: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as WinbackPrisma);
    await expect(repo.loadDispatchContext({ messageId: 'msg_1' })).resolves.toBeNull();
  });

  it('returns null when MerchantSettings is missing (degenerate merchant → no-op)', async () => {
    const repo = new CampaignRepository({
      campaignTarget: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ ...FULL_TARGET, merchant: { timezone: 'UTC', settings: null } }),
      },
    } as unknown as WinbackPrisma);
    await expect(repo.loadDispatchContext({ messageId: 'msg_1' })).resolves.toBeNull();
  });
});

// ===========================================================================
// Gate-chain writes (8.3)
// ===========================================================================

describe('CampaignRepository.deferTarget', () => {
  it('sets status=deferred guarded on status IN (pending, deferred); returns deferred:true on a hit', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const repo = new CampaignRepository({
      campaignTarget: { updateMany },
    } as unknown as WinbackPrisma);

    await expect(repo.deferTarget({ messageId: 'msg_1' })).resolves.toEqual({ deferred: true });
    expect(updateMany).toHaveBeenCalledWith({
      where: { messageId: 'msg_1', status: { in: ['pending', 'deferred'] } },
      data: { status: 'deferred' },
    });
  });

  it('deferred:false when the target is already terminal (0 rows)', async () => {
    const repo = new CampaignRepository({
      campaignTarget: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as WinbackPrisma);
    await expect(repo.deferTarget({ messageId: 'msg_1' })).resolves.toEqual({ deferred: false });
  });
});

describe('CampaignRepository.resolveTerminal', () => {
  function makeTxRepo(targetCount: number) {
    const campaignTargetUpdateMany = vi.fn().mockResolvedValue({ count: targetCount });
    const messageUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      campaignTarget: { updateMany: campaignTargetUpdateMany },
      message: { updateMany: messageUpdateMany },
    };
    const prisma = {
      $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    } as unknown as WinbackPrisma;
    return { repo: new CampaignRepository(prisma), campaignTargetUpdateMany, messageUpdateMany };
  }

  it('suppresses BOTH CampaignTarget + Message in one tx, with the forensic reason', async () => {
    const { repo, campaignTargetUpdateMany, messageUpdateMany } = makeTxRepo(1);

    await expect(
      repo.resolveTerminal({ messageId: 'msg_1', reason: 'consent' }),
    ).resolves.toEqual({ resolved: true });

    // 8.4 widened the CAS guard to include 'sending' so a non-retryable error
    // caught AFTER the pre-send tx can still terminalise the row.
    expect(campaignTargetUpdateMany).toHaveBeenCalledWith({
      where: { messageId: 'msg_1', status: { in: ['pending', 'deferred', 'sending'] } },
      data: { status: 'suppressed', suppressedByGate: 'consent' },
    });
    expect(messageUpdateMany).toHaveBeenCalledWith({
      where: { id: 'msg_1', status: 'draft' },
      data: { status: 'suppressed' },
    });
  });

  it("8.4 widening: status='failed' advances Message → 'failed' (burned draft must not look dispatchable)", async () => {
    const { repo, campaignTargetUpdateMany, messageUpdateMany } = makeTxRepo(1);

    await expect(
      repo.resolveTerminal({ messageId: 'msg_1', reason: 'email_auth', status: 'failed' }),
    ).resolves.toEqual({ resolved: true });

    expect(campaignTargetUpdateMany).toHaveBeenCalledWith({
      where: { messageId: 'msg_1', status: { in: ['pending', 'deferred', 'sending'] } },
      data: { status: 'failed', suppressedByGate: 'email_auth' },
    });
    expect(messageUpdateMany).toHaveBeenCalledWith({
      where: { id: 'msg_1', status: 'draft' },
      data: { status: 'failed' },
    });
  });

  it('RACE GUARD: CampaignTarget update touches 0 rows → resolved:false AND Message is NOT touched', async () => {
    const { repo, messageUpdateMany } = makeTxRepo(0);

    await expect(
      repo.resolveTerminal({ messageId: 'msg_1', reason: 'freshness' }),
    ).resolves.toEqual({ resolved: false });
    // The two writes can never diverge — no Message write when the target was
    // already terminal (another worker won the race).
    expect(messageUpdateMany).not.toHaveBeenCalled();
  });

  it('carries the arm-2 lifecycle reasons (campaign_paused / deferred_stale) the same way', async () => {
    const { repo, campaignTargetUpdateMany } = makeTxRepo(1);
    await repo.resolveTerminal({ messageId: 'msg_2', reason: 'campaign_paused' });
    expect(campaignTargetUpdateMany.mock.calls[0]![0].data.suppressedByGate).toBe('campaign_paused');
  });
});

describe('CampaignRepository.findDeferredTargets', () => {
  it('returns deferred targets with createdAt (defer-age anchor) + campaignActive', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        messageId: 'msg_1',
        campaignId: 'camp_1',
        customerId: 'cust_1',
        createdAt: new Date('2026-06-10T00:00:00Z'),
        campaign: { status: 'active' },
      },
      {
        messageId: 'msg_2',
        campaignId: 'camp_2',
        customerId: 'cust_2',
        createdAt: new Date('2026-06-01T00:00:00Z'),
        campaign: { status: 'paused' },
      },
    ]);
    const repo = new CampaignRepository({
      campaignTarget: { findMany },
    } as unknown as WinbackPrisma);

    await expect(repo.findDeferredTargets({ merchantId: MERCHANT_ID })).resolves.toEqual([
      {
        messageId: 'msg_1',
        campaignId: 'camp_1',
        customerId: 'cust_1',
        createdAt: new Date('2026-06-10T00:00:00Z'),
        campaignActive: true,
      },
      {
        messageId: 'msg_2',
        campaignId: 'camp_2',
        customerId: 'cust_2',
        createdAt: new Date('2026-06-01T00:00:00Z'),
        campaignActive: false,
      },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: { merchantId: MERCHANT_ID, status: 'deferred' },
      select: {
        messageId: true,
        campaignId: true,
        customerId: true,
        createdAt: true,
        campaign: { select: { status: true } },
      },
    });
  });
});
