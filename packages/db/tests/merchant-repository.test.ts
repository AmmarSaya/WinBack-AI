/**
 * Unit tests for MerchantRepository.
 *
 * Mock-prisma pattern (same as gdpr-processor.test.ts). The point is to
 * exercise the repository's control flow and arg shapes — what
 * upsertInstall passes to `merchant.upsert`, that findByShop reads from
 * the right table, that updateEnrichment sets `shopDetailsFetchedAt`,
 * etc. Behavior that depends on Prisma extension semantics
 * (cross-tenant rejection on hardDelete, etc.) is covered by
 * `tenant-scope.test.ts` plus the M3 integration smoke.
 *
 * The optional `tx` parameter is exercised in every test: each method is
 * called both with the repository's own prisma (default path) and with
 * a passed-in tx (transactional path). Both must call the same delegate
 * methods with the same arguments — divergence would be a tenant-safety
 * bug.
 */

import { describe, expect, it, vi } from 'vitest';

import type { WinbackPrisma } from '../src/client.js';
import { MerchantRepository } from '../src/repositories/merchant.repository.js';
import { withSystemScope, withTenantScope } from '../src/tenant-scope.js';

interface MerchantRow {
  id: string;
  shop: string;
}

interface MockState {
  merchants: MerchantRow[];
  updates: { where: { id: string }; data: Record<string, unknown> }[];
  deletes: { id: string }[];
  callLog: string[];
}

function makeMockPrisma(initial: Partial<MockState> = {}) {
  const state: MockState = {
    merchants: initial.merchants ?? [],
    updates: initial.updates ?? [],
    deletes: initial.deletes ?? [],
    callLog: initial.callLog ?? [],
  };

  const merchantDelegate = {
    findUnique: vi.fn(async (args: { where: { shop?: string; id?: string }; select?: unknown }) => {
      state.callLog.push(`merchant.findUnique where=${JSON.stringify(args.where)}`);
      if (args.where.shop !== undefined) {
        const row = state.merchants.find((m) => m.shop === args.where.shop);
        return row ? { id: row.id } : null;
      }
      if (args.where.id !== undefined) {
        const row = state.merchants.find((m) => m.id === args.where.id);
        return row ? { id: row.id } : null;
      }
      return null;
    }),
    upsert: vi.fn(
      async (args: {
        where: { shop: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
        select?: unknown;
      }) => {
        state.callLog.push(
          `merchant.upsert shop=${args.where.shop} create=${JSON.stringify(args.create)} update=${JSON.stringify(args.update)}`,
        );
        const existing = state.merchants.find((m) => m.shop === args.where.shop);
        if (existing !== undefined) {
          return { id: existing.id };
        }
        const id = `m_${String(state.merchants.length + 1)}`;
        state.merchants.push({ id, shop: args.where.shop });
        return { id };
      },
    ),
    update: vi.fn(
      async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        state.callLog.push(`merchant.update id=${args.where.id}`);
        state.updates.push({ where: args.where, data: args.data });
        return { id: args.where.id };
      },
    ),
    delete: vi.fn(async (args: { where: { id: string } }) => {
      state.callLog.push(`merchant.delete id=${args.where.id}`);
      state.deletes.push({ id: args.where.id });
      state.merchants = state.merchants.filter((m) => m.id !== args.where.id);
      return { id: args.where.id };
    }),
  };

  const prisma = { merchant: merchantDelegate } as unknown as WinbackPrisma;
  return { prisma, state, merchantDelegate };
}

// ===========================================================================
// findByShop
// ===========================================================================

describe('MerchantRepository.findByShop', () => {
  it('returns { id } when the merchant exists', async () => {
    const { prisma, state } = makeMockPrisma({
      merchants: [{ id: 'm_1', shop: 'foo.myshopify.com' }],
    });
    const repo = new MerchantRepository(prisma);

    const result = await repo.findByShop('foo.myshopify.com');
    expect(result).toEqual({ id: 'm_1' });
    expect(state.callLog).toContain(
      'merchant.findUnique where={"shop":"foo.myshopify.com"}',
    );
  });

  it('returns null when the merchant does not exist (idempotent shop_redact probe)', async () => {
    const { prisma } = makeMockPrisma();
    const repo = new MerchantRepository(prisma);
    expect(await repo.findByShop('absent.myshopify.com')).toBeNull();
  });

  it('uses the passed-in tx when provided (joins surrounding transaction)', async () => {
    const { prisma: defaultPrisma } = makeMockPrisma();
    const tx = makeMockPrisma({
      merchants: [{ id: 'm_tx', shop: 'foo.myshopify.com' }],
    });
    const repo = new MerchantRepository(defaultPrisma);

    const result = await repo.findByShop(
      'foo.myshopify.com',
      tx.prisma as never,
    );
    expect(result).toEqual({ id: 'm_tx' });
    // The default prisma's merchant delegate must NOT have been called.
    expect(
      (defaultPrisma.merchant as unknown as { findUnique: { mock: { calls: unknown[] } } })
        .findUnique.mock.calls.length,
    ).toBe(0);
    expect(tx.merchantDelegate.findUnique.mock.calls.length).toBe(1);
  });
});

// ===========================================================================
// upsertInstall
// ===========================================================================

describe('MerchantRepository.upsertInstall', () => {
  it('new install: creates the merchant and reports isNewInstall=true', async () => {
    const { prisma, state, merchantDelegate } = makeMockPrisma();
    const repo = new MerchantRepository(prisma);

    const result = await repo.upsertInstall({ shop: 'new.myshopify.com' });
    expect(result.isNewInstall).toBe(true);
    expect(result.id).toBe('m_1');

    // upsert.create must include shop + installedAt; update must clear
    // tokenRevokedAt + uninstalledAt.
    const upsertCall = merchantDelegate.upsert.mock.calls[0]![0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(upsertCall.create.shop).toBe('new.myshopify.com');
    expect(upsertCall.create.installedAt).toBeInstanceOf(Date);
    expect(upsertCall.update).toEqual({ tokenRevokedAt: null, uninstalledAt: null });

    // Pre-check (findUnique) happens before upsert.
    expect(state.callLog[0]).toMatch(/^merchant\.findUnique/);
    expect(state.callLog[1]).toMatch(/^merchant\.upsert/);
  });

  it('reinstall: returns isNewInstall=false and clears tokenRevokedAt + uninstalledAt', async () => {
    const { prisma, merchantDelegate } = makeMockPrisma({
      merchants: [{ id: 'm_existing', shop: 'existing.myshopify.com' }],
    });
    const repo = new MerchantRepository(prisma);

    const result = await repo.upsertInstall({ shop: 'existing.myshopify.com' });
    expect(result.isNewInstall).toBe(false);
    expect(result.id).toBe('m_existing');

    const upsertCall = merchantDelegate.upsert.mock.calls[0]![0] as {
      update: Record<string, unknown>;
    };
    // The "heal" semantics: even on reinstall the update block clears
    // revocation/uninstall timestamps. This is the load-bearing detail
    // the install.ts header comment depends on.
    expect(upsertCall.update).toEqual({ tokenRevokedAt: null, uninstalledAt: null });
  });

  it('uses the passed-in tx (single-transaction install flow)', async () => {
    const { prisma: defaultPrisma } = makeMockPrisma();
    const tx = makeMockPrisma();
    const repo = new MerchantRepository(defaultPrisma);

    await repo.upsertInstall({ shop: 'foo.myshopify.com' }, tx.prisma as never);
    expect(tx.merchantDelegate.findUnique.mock.calls.length).toBe(1);
    expect(tx.merchantDelegate.upsert.mock.calls.length).toBe(1);
    expect(
      (defaultPrisma.merchant as unknown as { upsert: { mock: { calls: unknown[] } } })
        .upsert.mock.calls.length,
    ).toBe(0);
  });
});

// ===========================================================================
// updateEnrichment
// ===========================================================================

describe('MerchantRepository.updateEnrichment', () => {
  it('sets every enrichment field + shopDetailsFetchedAt to now()', async () => {
    const { prisma, state } = makeMockPrisma({
      merchants: [{ id: 'm_1', shop: 'foo.myshopify.com' }],
    });
    const repo = new MerchantRepository(prisma);

    const before = Date.now();
    await repo.updateEnrichment('m_1', {
      email: 'owner@example.com',
      name: 'Foo Store',
      country: 'US',
      currency: 'USD',
      timezone: 'America/Los_Angeles',
      shopifyPlan: 'basic',
    });
    const after = Date.now();

    expect(state.updates).toHaveLength(1);
    const update = state.updates[0]!;
    expect(update.where).toEqual({ id: 'm_1' });
    expect(update.data.email).toBe('owner@example.com');
    expect(update.data.name).toBe('Foo Store');
    expect(update.data.country).toBe('US');
    expect(update.data.currency).toBe('USD');
    expect(update.data.timezone).toBe('America/Los_Angeles');
    expect(update.data.shopifyPlan).toBe('basic');
    const ts = update.data.shopDetailsFetchedAt as Date;
    expect(ts).toBeInstanceOf(Date);
    expect(ts.getTime()).toBeGreaterThanOrEqual(before);
    expect(ts.getTime()).toBeLessThanOrEqual(after);
  });

  it('accepts null on every nullable enrichment field (Shopify returned nulls)', async () => {
    const { prisma, state } = makeMockPrisma({
      merchants: [{ id: 'm_1', shop: 'foo.myshopify.com' }],
    });
    const repo = new MerchantRepository(prisma);

    await repo.updateEnrichment('m_1', {
      email: null,
      name: null,
      country: null,
      currency: null,
      timezone: null,
      shopifyPlan: null,
    });

    const update = state.updates[0]!;
    expect(update.data.email).toBeNull();
    expect(update.data.name).toBeNull();
    expect(update.data.country).toBeNull();
    expect(update.data.currency).toBeNull();
    expect(update.data.timezone).toBeNull();
    expect(update.data.shopifyPlan).toBeNull();
    // Timestamp still set even when fields are null — distinguishes
    // "not yet fetched" from "fetched, but Shopify returned nulls."
    expect(update.data.shopDetailsFetchedAt).toBeInstanceOf(Date);
  });

  it('uses the passed-in tx (joins the enrichInstall UoW)', async () => {
    const { prisma: defaultPrisma } = makeMockPrisma();
    const tx = makeMockPrisma({
      merchants: [{ id: 'm_1', shop: 'foo.myshopify.com' }],
    });
    const repo = new MerchantRepository(defaultPrisma);

    await repo.updateEnrichment(
      'm_1',
      {
        email: 'a@b.com',
        name: null,
        country: null,
        currency: null,
        timezone: null,
        shopifyPlan: null,
      },
      tx.prisma as never,
    );
    expect(tx.merchantDelegate.update.mock.calls.length).toBe(1);
    expect(
      (defaultPrisma.merchant as unknown as { update: { mock: { calls: unknown[] } } })
        .update.mock.calls.length,
    ).toBe(0);
  });
});

// ===========================================================================
// hardDelete
// ===========================================================================

describe('MerchantRepository.hardDelete', () => {
  it('issues a delete keyed by id', async () => {
    const { prisma, state } = makeMockPrisma({
      merchants: [{ id: 'm_1', shop: 'foo.myshopify.com' }],
    });
    const repo = new MerchantRepository(prisma);

    await withSystemScope('test.merchant_hard_delete', async () => {
      await repo.hardDelete('m_1');
    });
    expect(state.deletes).toEqual([{ id: 'm_1' }]);
    // Verify the row is gone from the mock state — proxy for CASCADE.
    expect(state.merchants).toEqual([]);
  });

  it('uses the passed-in tx when provided', async () => {
    const { prisma: defaultPrisma } = makeMockPrisma();
    const tx = makeMockPrisma({
      merchants: [{ id: 'm_1', shop: 'foo.myshopify.com' }],
    });
    const repo = new MerchantRepository(defaultPrisma);

    await withSystemScope('test.merchant_hard_delete_with_tx', async () => {
      await repo.hardDelete('m_1', tx.prisma as never);
    });
    expect(tx.merchantDelegate.delete.mock.calls.length).toBe(1);
    expect(
      (defaultPrisma.merchant as unknown as { delete: { mock: { calls: unknown[] } } })
        .delete.mock.calls.length,
    ).toBe(0);
  });

  // Regression lock for M-1 (POINTS-TO-CONSIDER): hardDelete now asserts
  // system scope at the top. Calling it from tenant scope must throw.
  it('throws when called outside system scope (M-1 regression lock)', async () => {
    const { prisma } = makeMockPrisma({
      merchants: [{ id: 'm_1', shop: 'foo.myshopify.com' }],
    });
    const repo = new MerchantRepository(prisma);

    await expect(
      withTenantScope('m_1', async () => {
        await repo.hardDelete('m_1');
      }),
    ).rejects.toThrow(/MerchantRepository\.hardDelete requires system scope/);
  });

  it('throws when called with no scope at all (M-1 regression lock)', async () => {
    const { prisma } = makeMockPrisma({
      merchants: [{ id: 'm_1', shop: 'foo.myshopify.com' }],
    });
    const repo = new MerchantRepository(prisma);

    await expect(repo.hardDelete('m_1')).rejects.toThrow(
      /MerchantRepository\.hardDelete requires system scope/,
    );
  });
});
