import type { AdminClient } from './client.js';

/**
 * Subset of fields we read from Shopify's Shop query to populate the
 * Merchant row after install. Matches columns added in B1 v2.
 */
export interface ShopDetails {
  readonly email: string | null;
  readonly name: string | null;
  readonly country: string | null;
  readonly currency: string | null;
  readonly timezone: string | null;
  readonly plan: string | null;
}

const SHOP_DETAILS_QUERY = `
  query ShopDetails {
    shop {
      email
      name
      billingAddress { countryCodeV2 }
      currencyCode
      ianaTimezone
      plan { displayName partnerDevelopment shopifyPlus }
    }
  }
`;

interface RawShopResponse {
  shop?: {
    email?: string | null;
    name?: string | null;
    billingAddress?: { countryCodeV2?: string | null } | null;
    currencyCode?: string | null;
    ianaTimezone?: string | null;
    plan?: {
      displayName?: string | null;
      partnerDevelopment?: boolean | null;
      shopifyPlus?: boolean | null;
    } | null;
  };
}

/**
 * Fetches shop metadata via the Admin API and normalizes to ShopDetails.
 *
 * Used by the install flow to backfill `Merchant.email/name/country/
 * currency/timezone/shopifyPlan` once the OAuth handshake completes.
 * Failures should NOT block install — caller handles errors and lets the
 * background reconciliation worker retry.
 *
 * Estimated cost ~10 (small static query). The cost tracker will gate
 * accordingly.
 */
export async function fetchShopDetails(
  client: AdminClient,
  merchantId: string,
): Promise<ShopDetails> {
  const data = await client.graphql<RawShopResponse>(merchantId, {
    query: SHOP_DETAILS_QUERY,
    estimatedCost: 10,
  });
  const shop = data.shop ?? {};
  return {
    email: shop.email ?? null,
    name: shop.name ?? null,
    country: shop.billingAddress?.countryCodeV2 ?? null,
    currency: shop.currencyCode ?? null,
    timezone: shop.ianaTimezone ?? null,
    plan: normalizePlan(shop.plan),
  };
}

interface RawPlan {
  displayName?: string | null;
  partnerDevelopment?: boolean | null;
  shopifyPlus?: boolean | null;
}

function normalizePlan(plan: RawPlan | null | undefined): string | null {
  if (plan === null || plan === undefined) return null;
  if (plan.shopifyPlus === true) return 'plus';
  if (plan.partnerDevelopment === true) return 'partner_test';
  // Use displayName as-is (lowercased). Shopify returns "Basic", "Shopify", etc.
  const dn = plan.displayName;
  if (typeof dn === 'string' && dn.length > 0) return dn.toLowerCase();
  return null;
}
