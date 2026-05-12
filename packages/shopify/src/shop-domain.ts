/**
 * Validates a Shopify shop domain string.
 *
 * Shopify shop domains are of the form `<handle>.myshopify.com`. The handle
 * is lowercase alphanumerics + hyphens, 3–60 chars, must not start/end with
 * hyphen. We're a bit more permissive on length (Shopify enforces) but the
 * structural shape matters for security — an attacker-controlled `shop`
 * parameter that points to a non-myshopify.com host would let the OAuth
 * exchange call hit a wrong server.
 *
 * Call this BEFORE any HTTP request to a shop-derived URL.
 */
const SHOP_DOMAIN_PATTERN =
  /^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]\.myshopify\.com$/i;

export function isValidShopDomain(shop: string): boolean {
  if (typeof shop !== 'string' || shop.length === 0 || shop.length > 255) {
    return false;
  }
  return SHOP_DOMAIN_PATTERN.test(shop);
}

/**
 * Returns the lowercase canonical form of a shop domain, or null if
 * invalid. Use for storage keys / lookups.
 */
export function normalizeShopDomain(shop: string): string | null {
  if (!isValidShopDomain(shop)) return null;
  return shop.toLowerCase();
}
