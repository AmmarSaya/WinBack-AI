import { z } from 'zod';

/**
 * Zod schemas for Shopify webhook payload bodies.
 *
 * SOURCE AUTHORITY: EPIC-E-FIELD-MAPPING.md (committed at repo root in
 * Epic E session 1). Field shapes match Shopify Admin REST API version
 * `2026-04` — the version pinned in `packages/shopify/src/config.ts`.
 *
 * POLICY DECISIONS ENFORCED HERE:
 *   - P-4: `_set` money objects are authoritative; flat `total_price` etc.
 *     are validated as strings for cross-check but the repository reads
 *     from `_set.shop_money.amount` when storing to BigInt cents columns.
 *   - P-9: every object uses `.passthrough()` so Shopify-added fields in
 *     future API versions don't reject ingestion. Unknown fields are
 *     ignored (not stored).
 *
 * SHAPE DRIFT — if Shopify changes any field shape in a future API
 * version, that's a coordinated change: bump the version pin, regenerate
 * any GraphQL queries, update this file, update EPIC-E-FIELD-MAPPING.md
 * in the same commit.
 *
 * Inferred TypeScript types are exported for repository consumption
 * (`ShopifyOrderWebhookBody`, `ShopifyCustomerWebhookBody`).
 */

// ===========================================================================
// Shared
// ===========================================================================

/**
 * Shopify money string — e.g. "199.95". The strict format check
 * (rejects non-numeric, scientific notation, >2 decimal places) lives
 * in `parseMoneyToCents` (`@winback/db`); here we only require it's a
 * string. The repository calls `parseMoneyToCents` to convert.
 */
const moneyStringSchema = z.string();

/**
 * The `_set` money composite. Single named schema reused for
 * `total_price_set`, `subtotal_price_set`, `total_tax_set`,
 * `total_discounts_set` (Order), `price_set`, `total_discount_set`
 * (line items). One definition prevents the five from drifting apart.
 *
 * Per P-4, `shop_money.amount` is what gets stored in BigInt cents
 * columns; `presentment_money.amount` populates the matching presentment
 * column where one exists.
 */
const moneySetSchema = z
  .object({
    shop_money: z
      .object({
        amount: moneyStringSchema,
        currency_code: z.string(),
      })
      .passthrough(),
    presentment_money: z
      .object({
        amount: moneyStringSchema,
        currency_code: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

export type ShopifyMoneySet = z.infer<typeof moneySetSchema>;

// ===========================================================================
// Customer — marketing consent objects
// ===========================================================================

/**
 * `state` enum: `subscribed` | `not_subscribed` | `pending` | `unsubscribed`
 * | `redacted` per Shopify M3AAWG-compliance docs. We accept string here
 * (don't enforce the enum at parse time) because Shopify has historically
 * added values without notice; the repository's `acceptsMarketing` boolean
 * is derived via `state === 'subscribed'` so unknown values fall through
 * as `false` correctly.
 */
const emailMarketingConsentSchema = z
  .object({
    state: z.string(),
    opt_in_level: z.string().nullable().optional(),
    consent_updated_at: z.string().nullable().optional(),
  })
  .passthrough();

const smsMarketingConsentSchema = z
  .object({
    state: z.string(),
    opt_in_level: z.string().nullable().optional(),
    consent_updated_at: z.string().nullable().optional(),
    consent_collected_from: z.string().nullable().optional(),
  })
  .passthrough();

// ===========================================================================
// Order — embedded customer (P-10: FK only, not used to upsert Customer rows)
// ===========================================================================

const orderEmbeddedCustomerSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
  })
  .passthrough();

// ===========================================================================
// Order — line items
// ===========================================================================

const orderLineItemSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    product_id: z.union([z.number(), z.string()]).nullable().optional(),
    variant_id: z.union([z.number(), z.string()]).nullable().optional(),
    title: z.string(),
    quantity: z.number().int().nonnegative(),
    price: moneyStringSchema,
    price_set: moneySetSchema,
  })
  .passthrough();

export type ShopifyOrderLineItem = z.infer<typeof orderLineItemSchema>;

// ===========================================================================
// Order webhook body
// ===========================================================================

/**
 * Top-level body of `orders/create` and `orders/updated` webhooks. Mirrors
 * the Shopify Order REST resource shape (2026-04). Required fields here
 * are the ones EPIC-E-FIELD-MAPPING.md classifies as MAPPED or as a
 * mandatory source for a MAPPED computed field.
 *
 * Nullable + optional fields reflect Shopify's documented nullability
 * (e.g., `processed_at` is absent on some checkout paths; `customer` is
 * null for guest checkout).
 *
 * EXCLUDED fields (per the mapping doc) are NOT enumerated here — they
 * pass through via `.passthrough()` without rejection or extraction.
 */
export const shopifyOrderWebhookBodySchema = z
  .object({
    // Identity (row #1)
    id: z.union([z.number(), z.string()]),
    // Display name (row #10) — stored as Order.shopifyOrderNumber
    name: z.string().nullable().optional(),

    // Test flag (row #81)
    test: z.boolean().optional().default(false),

    // Status (rows #49, #50)
    financial_status: z.string().nullable().optional(),
    fulfillment_status: z.string().nullable().optional(),

    // Customer (FK lookup; row #19, P-10)
    customer: orderEmbeddedCustomerSchema.nullable().optional(),

    // Currency (rows #22, #23)
    currency: z.string(),
    presentment_currency: z.string().nullable().optional(),

    // Money — flat fields kept for cross-check at parse; _set fields
    // are authoritative for the repository's BigInt cents conversion.
    // Rows #24-31.
    //
    // Nullability split: `subtotal_price_set` and `total_price_set` are
    // REQUIRED — every order has a non-trivial subtotal and total.
    // `total_tax_set` and `total_discounts_set` are OPTIONAL — Shopify's
    // 2026-04 docs do NOT explicitly state field presence for zero-tax /
    // zero-discount orders. Defensive posture: accept absent. The
    // repository (batch 3) defaults `Order.totalTaxCents` / `totalDiscountCents`
    // to 0n when absent, matching the schema column `@default(0)`.
    subtotal_price: moneyStringSchema.nullable().optional(),
    subtotal_price_set: moneySetSchema,
    total_price: moneyStringSchema.nullable().optional(),
    total_price_set: moneySetSchema,
    total_tax: moneyStringSchema.nullable().optional(),
    total_tax_set: moneySetSchema.optional(),
    total_discounts: moneyStringSchema.nullable().optional(),
    total_discounts_set: moneySetSchema.optional(),

    // Timestamps (rows #4, #5, #6, #8)
    created_at: z.string(),
    updated_at: z.string(),
    processed_at: z.string().nullable().optional(),
    cancelled_at: z.string().nullable().optional(),

    // Line items (row #54)
    line_items: z.array(orderLineItemSchema),
  })
  .passthrough();

export type ShopifyOrderWebhookBody = z.infer<typeof shopifyOrderWebhookBodySchema>;

// ===========================================================================
// Customer webhook body
// ===========================================================================

/**
 * Top-level body of `customers/create` and `customers/update` webhooks.
 * Mirrors the Shopify Customer REST resource shape (2026-04).
 *
 * Per EPIC-E-FIELD-MAPPING.md C9: this is NOT used to write
 * `Customer.state` — Shopify's `state` (account-lifecycle:
 * `enabled`/`disabled`/`invited`/`declined`) is semantically different
 * from our `Customer.state` (RFM-lifecycle:
 * `active`/`warm`/`at_risk`/`dormant`/`lost`), even though they share a
 * field name. We explicitly do NOT pull `state` here.
 *
 * Per row C10: `total_spent` is excluded because it's a Shopify
 * cross-currency aggregate (meaningless for multi-currency stores).
 */
export const shopifyCustomerWebhookBodySchema = z
  .object({
    // Identity (row C1)
    id: z.union([z.number(), z.string()]),

    // Contact (rows C2, C3, C4, C5)
    email: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),

    // Timestamps (rows C6, C7)
    created_at: z.string(),
    updated_at: z.string(),

    // Cached orders count (row C8)
    orders_count: z.number().int().nonnegative().nullable().optional(),

    // Tags — comma-separated string per P-6 (row C18)
    tags: z.string().nullable().optional(),

    // Marketing consent — source for derived acceptsMarketing/acceptsSms
    // (rows C21, C22, C23)
    email_marketing_consent: emailMarketingConsentSchema.nullable().optional(),
    sms_marketing_consent: smsMarketingConsentSchema.nullable().optional(),
  })
  .passthrough();

export type ShopifyCustomerWebhookBody = z.infer<typeof shopifyCustomerWebhookBodySchema>;
