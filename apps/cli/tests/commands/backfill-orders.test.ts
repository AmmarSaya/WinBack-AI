/**
 * Unit tests for `runBackfillOrders` (the CLI command wrapper).
 *
 * Verifies: merchant-not-found branch; the happy backfilled branch wires
 * the BackfillRunner with the order fetcher/processor + ORDER resource;
 * the paused passthrough. `BackfillRunner` + `buildAdminClient` are mocked
 * — the real fetch/adapt/upsert is covered by the shopify adapter unit
 * tests + the drainer integration "backfill then score" proof.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));

vi.mock('@winback/db', async () => {
  const actual = await vi.importActual<typeof import('@winback/db')>('@winback/db');
  return {
    ...actual,
    withTenantScope: vi.fn(async (_merchantId: string, fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('@winback/shopify', async () => {
  const actual = await vi.importActual<typeof import('@winback/shopify')>('@winback/shopify');
  return {
    ...actual,
    buildAdminClient: vi.fn().mockReturnValue({ __stubAdminClient: true }),
    OrderPageFetcher: vi.fn().mockImplementation(() => ({ __fetcher: true })),
    OrderPageProcessor: vi.fn().mockImplementation(() => ({ __processor: true })),
    BackfillRunner: vi.fn().mockImplementation(() => ({ run: runMock })),
  };
});

const shopifyMod = await import('@winback/shopify');
const { runBackfillOrders } = await import('../../src/commands/backfill-orders.js');

function makeStubPrisma(merchantRow: { id: string } | null): {
  prisma: Parameters<typeof runBackfillOrders>[0]['prisma'];
  findUnique: ReturnType<typeof vi.fn>;
} {
  const findUnique = vi.fn().mockResolvedValue(merchantRow);
  return {
    prisma: { merchant: { findUnique } } as unknown as Parameters<
      typeof runBackfillOrders
    >[0]['prisma'],
    findUnique,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('runBackfillOrders', () => {
  it('merchant not found → { kind: merchant_not_found }, no runner', async () => {
    const { prisma } = makeStubPrisma(null);
    const result = await runBackfillOrders({ prisma, merchantId: 'm-missing' });
    expect(result).toEqual({ kind: 'merchant_not_found' });
    expect(shopifyMod.BackfillRunner).not.toHaveBeenCalled();
  });

  it('happy: builds AdminClient + runs BackfillRunner with ORDER resource; returns backfilled', async () => {
    const { prisma } = makeStubPrisma({ id: 'm-1' });
    runMock.mockResolvedValue({
      merchantId: 'm-1',
      resource: 'orders',
      pagesProcessed: 3,
      itemsProcessed: 120,
      finalStatus: 'completed',
    });

    const result = await runBackfillOrders({ prisma, merchantId: 'm-1' });

    expect(shopifyMod.buildAdminClient).toHaveBeenCalledWith(prisma);
    expect(shopifyMod.OrderPageFetcher).toHaveBeenCalledTimes(1);
    expect(shopifyMod.OrderPageProcessor).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith({ merchantId: 'm-1', resource: 'orders' });
    expect(result).toEqual({
      kind: 'backfilled',
      merchantId: 'm-1',
      pagesProcessed: 3,
      itemsProcessed: 120,
      finalStatus: 'completed',
    });
  });

  it('paused (token revoked mid-run) → backfilled with finalStatus=paused (passthrough)', async () => {
    const { prisma } = makeStubPrisma({ id: 'm-1' });
    runMock.mockResolvedValue({
      merchantId: 'm-1',
      resource: 'orders',
      pagesProcessed: 1,
      itemsProcessed: 40,
      finalStatus: 'paused',
    });

    const result = await runBackfillOrders({ prisma, merchantId: 'm-1' });
    expect(result).toMatchObject({ kind: 'backfilled', finalStatus: 'paused' });
  });
});
