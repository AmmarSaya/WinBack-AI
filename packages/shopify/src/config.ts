import { defineConfig } from '@winback/config';
import { z } from 'zod';

/**
 * Shopify app + crypto config. Validated lazily on first call.
 *
 * `SHOPIFY_API_VERSION` is the quarterly Shopify Admin API version
 * (e.g. "2026-04"). Bumps are intentional code changes, never auto.
 *
 * `ENCRYPTION_KEY` is the AES-256-GCM key for the session-token cipher
 * (base64-encoded 32 bytes). Generate locally with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Rotation procedure (when needed): generate a new key, deploy with both
 * keys configured (primary writes new; secondary decrypts old), background
 * job re-encrypts all sessions with primary, drop secondary. Multi-key
 * support lands when a real rotation is needed; for B3 we ship single-key.
 */

const SHOP_DOMAIN = /\.myshopify\.com$/i;

const shopifyConfigSchema = z.object({
  SHOPIFY_API_KEY: z.string().min(1, 'SHOPIFY_API_KEY is required'),
  SHOPIFY_API_SECRET: z.string().min(1, 'SHOPIFY_API_SECRET is required'),
  // zod 4: `z.url(msg)` is the new top-level form; replaces deprecated
  // `z.string().url(msg)`. Same `core._url(ZodURL, params)` implementation.
  SHOPIFY_APP_URL: z.url(
    'SHOPIFY_APP_URL must be a valid URL (e.g. https://app.example.com)',
  ),
  /** Comma-separated list, e.g. "read_customers,read_orders,write_discounts". */
  SHOPIFY_SCOPES: z.string().min(1, 'SHOPIFY_SCOPES is required'),
  SHOPIFY_API_VERSION: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'SHOPIFY_API_VERSION must be YYYY-MM (e.g. 2026-04)'),
  /**
   * Optional dedicated webhook secret. If unset, webhook HMAC uses
   * SHOPIFY_API_SECRET (Shopify default). Most apps don't need to set this.
   */
  SHOPIFY_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** Base64-encoded 32-byte key for @winback/crypto's Cipher. */
  ENCRYPTION_KEY: z
    .string()
    .min(1, 'ENCRYPTION_KEY is required')
    .refine((s) => {
      try {
        return Buffer.from(s, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'ENCRYPTION_KEY must be base64-encoded 32 bytes'),
});

export type ShopifyConfig = z.infer<typeof shopifyConfigSchema>;

let cached: ShopifyConfig | null = null;

export interface GetShopifyConfigOptions {
  readonly reset?: boolean;
  readonly source?: NodeJS.ProcessEnv | undefined;
}

export function getShopifyConfig(options?: GetShopifyConfigOptions): ShopifyConfig {
  if (options?.reset === true) cached = null;
  if (cached === null) {
    cached = defineConfig(
      shopifyConfigSchema,
      options?.source !== undefined ? { source: options.source } : {},
    );
  }
  return cached;
}

/** Convenience: parses scopes from the comma-separated env var into a Set. */
export function parseScopes(scopes: string): ReadonlySet<string> {
  return new Set(
    scopes
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** Used elsewhere for shop-domain validation. */
export { SHOP_DOMAIN };
