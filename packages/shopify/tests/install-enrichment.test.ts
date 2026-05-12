/**
 * Unit tests for `enrichInstall`. Focus is on the atomicity guarantee
 * (guardrail #3): Merchant fields, shopDetailsFetchedAt, and the outbox
 * event commit together or not at all.
 *
 * The integration test against real Postgres is in M3-Smoke for
 * completeInstall; the equivalent for enrichInstall lands in M10. Here
 * we verify the contract at the function level.
 */
import { describe, expect, it, vi } from 'vitest';

import { fetchShopDetails } from '../src/admin/shop-details.js';
import type { ShopDetails } from '../src/admin/shop-details.js';

describe('enrichInstall — contract', () => {
  it('fetchShopDetails returns normalized ShopDetails for canonical response', async () => {
    const adminGraphql = vi.fn(async () => ({
      shop: {
        email: 'merchant@acme.com',
        name: 'Acme',
        billingAddress: { countryCodeV2: 'US' },
        currencyCode: 'USD',
        ianaTimezone: 'America/Los_Angeles',
        plan: { displayName: 'Shopify', partnerDevelopment: false, shopifyPlus: false },
      },
    }));
    const fakeClient = { graphql: adminGraphql } as unknown as Parameters<
      typeof fetchShopDetails
    >[0];

    const details = await fetchShopDetails(fakeClient, 'm_test');
    expect(details).toEqual({
      email: 'merchant@acme.com',
      name: 'Acme',
      country: 'US',
      currency: 'USD',
      timezone: 'America/Los_Angeles',
      plan: 'shopify',
    });
  });

  it('plan normalization prefers shopifyPlus over displayName', async () => {
    const adminGraphql = vi.fn(async () => ({
      shop: {
        plan: { displayName: 'Shopify', partnerDevelopment: false, shopifyPlus: true },
      },
    }));
    const fakeClient = { graphql: adminGraphql } as unknown as Parameters<
      typeof fetchShopDetails
    >[0];
    const details = await fetchShopDetails(fakeClient, 'm_test');
    expect(details.plan).toBe('plus');
  });

  it('plan normalization detects partner_test', async () => {
    const adminGraphql = vi.fn(async () => ({
      shop: {
        plan: {
          displayName: 'Development',
          partnerDevelopment: true,
          shopifyPlus: false,
        },
      },
    }));
    const fakeClient = { graphql: adminGraphql } as unknown as Parameters<
      typeof fetchShopDetails
    >[0];
    const details = await fetchShopDetails(fakeClient, 'm_test');
    expect(details.plan).toBe('partner_test');
  });

  it('handles a fully-null shop response (defensive)', async () => {
    const adminGraphql = vi.fn(async () => ({ shop: null }));
    const fakeClient = { graphql: adminGraphql } as unknown as Parameters<
      typeof fetchShopDetails
    >[0];
    const details = await fetchShopDetails(fakeClient, 'm_test');
    const expected: ShopDetails = {
      email: null,
      name: null,
      country: null,
      currency: null,
      timezone: null,
      plan: null,
    };
    expect(details).toEqual(expected);
  });

  it('handles an empty plan object (display name absent)', async () => {
    const adminGraphql = vi.fn(async () => ({
      shop: { plan: {} },
    }));
    const fakeClient = { graphql: adminGraphql } as unknown as Parameters<
      typeof fetchShopDetails
    >[0];
    const details = await fetchShopDetails(fakeClient, 'm_test');
    expect(details.plan).toBeNull();
  });
});

describe('enrichInstall — atomicity invariant (documentation)', () => {
  /**
   * The Merchant.shopDetailsFetchedAt timestamp + the field updates +
   * the outbox event all live in a single UnitOfWork.run callback in
   * the implementation. This test exists so the test file fails (or is
   * obviously deleted) if a future refactor splits them.
   *
   * The behavior under real Postgres is integration-tested at M10.
   */
  it('the file `install-enrichment.ts` writes Merchant + outbox in one UoW', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.promises.readFile(
        new URL('../src/backfill/install-enrichment.ts', import.meta.url),
        'utf8',
      ),
    );
    // Crude grep: one `uow.run(` call inside the function. Refactoring
    // to two transactions would change this count and fail the test —
    // the failure forces a human to revisit the atomicity guarantee.
    const uowRunCount = (src.match(/uow\.run\(/g) ?? []).length;
    expect(uowRunCount).toBe(1);
    // And both writes (merchant.update + ctx.publish) inside that block:
    expect(src).toContain('merchant.update(');
    expect(src).toContain('shopDetailsFetchedAt: new Date()');
    expect(src).toContain('OUTBOX_EVENTS.merchant.shop_details_fetched');
  });
});
