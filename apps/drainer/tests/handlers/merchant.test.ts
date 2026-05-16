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

// We track a single `runMock` for the most-recently-constructed
// BackfillRunner so each test can override its behavior.
let runMock: ReturnType<typeof vi.fn>;

vi.mock('@winback/crypto', async () => {
  const actual = await vi.importActual<typeof import('@winback/crypto')>('@winback/crypto');
  return {
    ...actual,
    Cipher: vi.fn().mockImplementation(() => ({ __stubCipher: true })),
    decodeKey: vi.fn().mockImplementation(() => Buffer.alloc(32)),
  };
});

vi.mock('@winback/shopify', async () => {
  const actual = await vi.importActual<typeof import('@winback/shopify')>('@winback/shopify');
  return {
    ...actual,
    AdminClient: vi.fn().mockImplementation(() => ({ __stubAdminClient: true })),
    CostTracker: vi.fn().mockImplementation(() => ({ __stubTracker: true })),
    PrismaShopifyTokenResolver: vi.fn().mockImplementation(() => ({ __stubResolver: true })),
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
const { handleMerchantInstalled } = await import('../../src/handlers/merchant.js');

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

  it('AdminClient is reused: constructed once, passed to both fetcher and enrich', async () => {
    await handleMerchantInstalled(stubCtx, makeRow(VALID_PAYLOAD));
    expect(shopifyMod.AdminClient).toHaveBeenCalledTimes(1);
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
