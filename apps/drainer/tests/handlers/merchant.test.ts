/**
 * merchant.installed adapter tests.
 *
 * Verifies:
 *   - payload narrowing via zod
 *   - enrichInstall called with the constructed AdminClient
 *   - BackfillRunner constructed with (prisma, fetcher, processor) and
 *     `.run` called with {merchantId, resource}
 *   - enrichInstall success:false → log warn + continue (handler does
 *     NOT throw)
 *   - BackfillRunner returns paused → handler returns normally
 *   - BackfillRunner throws → handler throws (drainer catches at MBI
 *     phase 2 boundary)
 *
 * The Cipher / PrismaShopifyTokenResolver / CostTracker / AdminClient
 * construction is faked at the @winback/crypto + @winback/shopify
 * module boundary. We assert behavior, not the literal four-line
 * ritual.
 */

import type { OutboxEventRow } from '@winback/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock @winback/db's MerchantRepository BEFORE handler import so the
// drainer's handleMerchantUninstalled gets the stubbed constructor.
vi.mock('@winback/db', async () => {
  const actual = await vi.importActual<typeof import('@winback/db')>('@winback/db');
  return {
    ...actual,
    MerchantRepository: vi.fn().mockImplementation(() => ({
      markUninstalled: vi.fn().mockResolvedValue({ updatedCount: 1 }),
    })),
  };
});

// We track a single `runMock` for the most-recently-constructed
// BackfillRunner so each test can override its behavior.
let runMock: ReturnType<typeof vi.fn>;

vi.mock('@winback/shopify', async () => {
  const actual = await vi.importActual<typeof import('@winback/shopify')>('@winback/shopify');
  return {
    ...actual,
    buildAdminClient: vi.fn().mockImplementation(() => ({ __stubAdminClient: true })),
    CustomerPageFetcher: vi.fn().mockImplementation(() => ({ __stubFetcher: true })),
    CustomerPageProcessor: vi.fn().mockImplementation(() => ({ __stubProcessor: true })),
    BackfillRunner: vi.fn().mockImplementation(() => ({
      run: (runMock = vi.fn().mockResolvedValue({
        merchantId: 'merchant-1',
        resource: 'customers',
        pagesProcessed: 2,
        itemsProcessed: 100,
        finalStatus: 'completed',
      })),
    })),
    enrichInstall: vi.fn().mockResolvedValue({ merchantId: 'merchant-1', success: true }),
  };
});

const shopifyMod = await import('@winback/shopify');
const dbMod = await import('@winback/db');
const { handleMerchantInstalled, handleMerchantUninstalled } = await import('../../src/handlers/merchant.js');

function makeRow(payload: unknown): OutboxEventRow {
  return {
    id: 'row-merch',
    merchantId: 'merchant-1',
    type: 'merchant.installed',
    payload,
    createdAt: new Date(),
    attempts: 0,
  };
}

const stubCtx = {
  prisma: { __stubPrisma: true } as unknown,
  queues: {},
  shopifyConfig: { ENCRYPTION_KEY: 'a'.repeat(44) },
} as unknown as Parameters<typeof handleMerchantInstalled>[0];

const VALID_PAYLOAD = { shop: 'foo.myshopify.com', scope: 'read_customers', reinstall: false };

afterEach(() => {
  vi.clearAllMocks();
});

describe('handleMerchantInstalled — happy path', () => {
  it('calls enrichInstall, then BackfillRunner.run with the customers resource', async () => {
    await handleMerchantInstalled(stubCtx, makeRow(VALID_PAYLOAD));

    expect(shopifyMod.enrichInstall).toHaveBeenCalledTimes(1);
    expect(shopifyMod.enrichInstall).toHaveBeenCalledWith(
      stubCtx.prisma,
      expect.anything(),
      'merchant-1',
    );

    expect(shopifyMod.BackfillRunner).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith({
      merchantId: 'merchant-1',
      resource: shopifyMod.CUSTOMER_BACKFILL_RESOURCE,
    });
  });

  it('AdminClient is reused: buildAdminClient called once, fetcher constructed once', async () => {
    await handleMerchantInstalled(stubCtx, makeRow(VALID_PAYLOAD));
    expect(shopifyMod.buildAdminClient).toHaveBeenCalledTimes(1);
    expect(shopifyMod.buildAdminClient).toHaveBeenCalledWith(stubCtx.prisma, stubCtx.shopifyConfig);
    expect(shopifyMod.CustomerPageFetcher).toHaveBeenCalledTimes(1);
  });
});

describe('handleMerchantInstalled — enrichInstall non-success', () => {
  it('logs warn but does NOT throw on enrichInstall {success: false}', async () => {
    vi.mocked(shopifyMod.enrichInstall).mockResolvedValueOnce({
      merchantId: 'merchant-1',
      success: false,
      reason: 'shop_query_failed',
    });

    await expect(handleMerchantInstalled(stubCtx, makeRow(VALID_PAYLOAD))).resolves.not.toThrow();
    // Backfill still attempted after enrichment failure (consistent with D2 = α).
    expect(runMock).toHaveBeenCalledTimes(1);
  });
});

describe('handleMerchantInstalled — BackfillRunner outcomes', () => {
  it('returns normally when runner returns finalStatus: paused', async () => {
    const captured = vi.fn().mockResolvedValueOnce({
      merchantId: 'merchant-1',
      resource: 'customers',
      pagesProcessed: 0,
      itemsProcessed: 0,
      finalStatus: 'paused',
    });
    vi.mocked(shopifyMod.BackfillRunner).mockImplementationOnce(
      () => ({ run: captured }) as unknown as InstanceType<typeof shopifyMod.BackfillRunner>,
    );

    await expect(handleMerchantInstalled(stubCtx, makeRow(VALID_PAYLOAD))).resolves.not.toThrow();
  });

  it('throws when BackfillRunner.run throws', async () => {
    const thrower = vi.fn().mockRejectedValueOnce(new Error('shopify down'));
    vi.mocked(shopifyMod.BackfillRunner).mockImplementationOnce(
      () => ({ run: thrower }) as unknown as InstanceType<typeof shopifyMod.BackfillRunner>,
    );

    await expect(
      handleMerchantInstalled(stubCtx, makeRow(VALID_PAYLOAD)),
    ).rejects.toThrow('shopify down');
  });
});

describe('handleMerchantInstalled — payload validation', () => {
  it('throws on missing required fields', async () => {
    await expect(
      handleMerchantInstalled(stubCtx, makeRow({ shop: 'foo' /* no scope, no reinstall */ })),
    ).rejects.toThrow();
    expect(shopifyMod.enrichInstall).not.toHaveBeenCalled();
  });
});

describe('handleMerchantUninstalled', () => {
  function makeUninstallRow(): OutboxEventRow {
    return {
      id: 'row-uninstall',
      merchantId: 'merchant-1',
      type: 'merchant.uninstalled',
      payload: { topic: 'app/uninstalled', webhookId: 'wh-xyz', body: {} },
      createdAt: new Date(),
      attempts: 0,
    };
  }

  it('constructs MerchantRepository with ctx.prisma and calls markUninstalled(merchantId)', async () => {
    const markUninstalledMock = vi.fn().mockResolvedValue({ updatedCount: 1 });
    vi.mocked(dbMod.MerchantRepository).mockImplementationOnce(
      () => ({ markUninstalled: markUninstalledMock }) as unknown as InstanceType<
        typeof dbMod.MerchantRepository
      >,
    );

    await handleMerchantUninstalled(stubCtx, makeUninstallRow());

    expect(dbMod.MerchantRepository).toHaveBeenCalledWith(stubCtx.prisma);
    expect(markUninstalledMock).toHaveBeenCalledTimes(1);
    expect(markUninstalledMock).toHaveBeenCalledWith('merchant-1');
  });

  it('returns successfully on duplicate delivery (updatedCount: 0)', async () => {
    const markUninstalledMock = vi.fn().mockResolvedValue({ updatedCount: 0 });
    vi.mocked(dbMod.MerchantRepository).mockImplementationOnce(
      () => ({ markUninstalled: markUninstalledMock }) as unknown as InstanceType<
        typeof dbMod.MerchantRepository
      >,
    );

    await expect(handleMerchantUninstalled(stubCtx, makeUninstallRow())).resolves.toBeUndefined();
  });

  it('bubbles repository throw to caller (drainer dispatch catches → markFailed)', async () => {
    const markUninstalledMock = vi.fn().mockRejectedValue(new Error('db down'));
    vi.mocked(dbMod.MerchantRepository).mockImplementationOnce(
      () => ({ markUninstalled: markUninstalledMock }) as unknown as InstanceType<
        typeof dbMod.MerchantRepository
      >,
    );

    await expect(handleMerchantUninstalled(stubCtx, makeUninstallRow())).rejects.toThrow('db down');
  });
});
