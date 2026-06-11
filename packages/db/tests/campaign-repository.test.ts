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
