/**
 * Helpers that wrap Shopify numeric IDs (as received in REST webhook
 * payloads) into full GIDs of the form `gid://shopify/<Resource>/<numeric>`.
 *
 * Storing GIDs everywhere (per locked architectural decision #4 — see
 * ARCHITECTURE.md and the schema.prisma header) means the boundary cost
 * is at the WEBHOOK INGEST POINT — every consumer of the body's numeric
 * `id`/`product_id`/`variant_id` etc. wraps before persisting. The cost
 * of that single wrap call is the price of having unambiguous resource
 * references throughout the data layer.
 *
 * Each helper accepts `string | number` and returns `string | null` on
 * malformed input. Callers MUST handle null (skip + log per the
 * no-silent-passthrough invariant — storing malformed values is how
 * corruption spreads).
 *
 * Naming: `toShopify<Resource>Gid`. Pre-Epic-E only `toCustomerGid`
 * existed (in `./backfill/customer-backfill.ts`); session 1 of Epic E
 * renamed + relocated all five to this shared module so the
 * Order / Customer / Product / Variant / LineItem upsert paths can
 * share the wrap discipline.
 */

const NUMERIC_PATTERN = /^\d+$/;

function wrap(resource: string, numericId: string | number): string | null {
  const s = String(numericId);
  if (!NUMERIC_PATTERN.test(s)) return null;
  return `gid://shopify/${resource}/${s}`;
}

export function toShopifyCustomerGid(numericId: string | number): string | null {
  return wrap('Customer', numericId);
}

export function toShopifyOrderGid(numericId: string | number): string | null {
  return wrap('Order', numericId);
}

export function toShopifyProductGid(numericId: string | number): string | null {
  return wrap('Product', numericId);
}

export function toShopifyVariantGid(numericId: string | number): string | null {
  return wrap('ProductVariant', numericId);
}

export function toShopifyLineItemGid(numericId: string | number): string | null {
  return wrap('LineItem', numericId);
}
