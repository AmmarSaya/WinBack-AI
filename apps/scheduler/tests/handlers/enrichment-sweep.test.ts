/**
 * Unit tests for runEnrichmentSweep.
 *
 * Covers:
 *   - the cross-tenant SELECT for un-enriched merchants runs
 *   - per-merchant try/catch wraps enrichInstall (one failure doesn't
 *     terminate the sweep)
 *   - enrichInstall {success: true} → success count, no throw
 *   - enrichInstall {success: false} → failure count, no throw
 *   - enrichInstall unexpected throw → caught, failure count
 *   - empty SELECT short-circuits (no enrichInstall calls)
 *
 * buildAdminClient + enrichInstall are mocked at the @winback/shopify
 * module boundary.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SchedulerContext } from '../../src/context.js';

vi.mock('@winback/shopify', async () => {
  const actual = await vi.importActual<typeof import('@winback/shopify')>('@winback/shopify');
  return {
    ...actual,
    buildAdminClient: vi.fn().mockImplementation(() => ({ __stubAdminClient: true })),
    enrichInstall: vi.fn(),
  };
});

const shopifyMod = await import('@winback/shopify');
const { runEnrichmentSweep } = await import('../../src/handlers/enrichment-sweep.js');

interface MockedPrisma {
  $queryRaw: ReturnType<typeof vi.fn>;
}

function makeCtx(prisma: MockedPrisma): SchedulerContext {
  return {
    prisma: prisma as unknown as SchedulerContext['prisma'],
    queues: {} as SchedulerContext['queues'],
    shopifyConfig: { ENCRYPTION_KEY: 'a'.repeat(44) } as unknown as SchedulerContext['shopifyConfig'],
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('runEnrichmentSweep — happy path', () => {
  it('selects un-enriched merchants, calls enrichInstall for each, returns successfully', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([
      { id: 'm-1' },
      { id: 'm-2' },
      { id: 'm-3' },
    ]);
    vi.mocked(shopifyMod.enrichInstall).mockResolvedValue({
      merchantId: 'mocked',
      success: true,
    });

    await runEnrichmentSweep(makeCtx({ $queryRaw: queryRaw }));

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(shopifyMod.buildAdminClient).toHaveBeenCalledTimes(3);
    expect(shopifyMod.enrichInstall).toHaveBeenCalledTimes(3);
  });

  it('empty SELECT short-circuits (no enrichInstall calls)', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([]);
    await runEnrichmentSweep(makeCtx({ $queryRaw: queryRaw }));

    expect(shopifyMod.enrichInstall).not.toHaveBeenCalled();
    expect(shopifyMod.buildAdminClient).not.toHaveBeenCalled();
  });
});

describe('runEnrichmentSweep — failure containment', () => {
  it('enrichInstall {success: false} does not stop iteration', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([
      { id: 'm-1' },
      { id: 'm-2' },
      { id: 'm-3' },
    ]);
    vi.mocked(shopifyMod.enrichInstall)
      .mockResolvedValueOnce({ merchantId: 'm-1', success: true })
      .mockResolvedValueOnce({ merchantId: 'm-2', success: false, reason: 'shop_query_failed' })
      .mockResolvedValueOnce({ merchantId: 'm-3', success: true });

    await expect(runEnrichmentSweep(makeCtx({ $queryRaw: queryRaw }))).resolves.toBeUndefined();
    expect(shopifyMod.enrichInstall).toHaveBeenCalledTimes(3);
  });

  it('enrichInstall unexpected throw is caught; iteration continues', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([
      { id: 'm-1' },
      { id: 'm-bad' },
      { id: 'm-3' },
    ]);
    vi.mocked(shopifyMod.enrichInstall)
      .mockResolvedValueOnce({ merchantId: 'm-1', success: true })
      .mockRejectedValueOnce(new Error('shopify-side outage'))
      .mockResolvedValueOnce({ merchantId: 'm-3', success: true });

    await expect(runEnrichmentSweep(makeCtx({ $queryRaw: queryRaw }))).resolves.toBeUndefined();
    expect(shopifyMod.enrichInstall).toHaveBeenCalledTimes(3);
  });
});

describe('runEnrichmentSweep — AdminClient construction', () => {
  it('buildAdminClient receives prisma + shopifyConfig from ctx', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{ id: 'm-1' }]);
    vi.mocked(shopifyMod.enrichInstall).mockResolvedValue({
      merchantId: 'm-1',
      success: true,
    });
    const ctx = makeCtx({ $queryRaw: queryRaw });

    await runEnrichmentSweep(ctx);

    expect(shopifyMod.buildAdminClient).toHaveBeenCalledWith(ctx.prisma, ctx.shopifyConfig);
  });
});
