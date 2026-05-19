# Epic E Session 1 — Shopify Webhook → Schema Field Mapping

**Status:** DRAFT — awaiting senior review approval before any schema or repository code is written.
**Scope:** Webhooks consumed by the drainer in Epic E session 1 — `orders/create`, `orders/updated`, `customers/create`, `customers/update`. Other order/customer subtypes (`orders/cancelled`, `customers/delete`) inherit the same mapping; their handlers are separate work items in the same session.
**Source authority:** Shopify Admin REST API documentation, version `2026-04` — `https://shopify.dev/docs/api/admin-rest/2026-04/resources/order` and `https://shopify.dev/docs/api/admin-rest/2026-04/resources/customer`. Webhook payload shape matches the REST resource shape with the resource as the top-level object.
**Schema reference:** [packages/db/prisma/schema.prisma](packages/db/prisma/schema.prisma) at `main` SHA `1c7df92`.

This document is a permanent contract. Any future change to the Order or Customer webhook handlers MUST update this file in the same commit. If Shopify adds a field in a future API version, the schema decision is made here BEFORE any code change.

---

## Policy decisions (read before the per-field tables)

These rules apply across both Order and Customer mappings. Where a per-field decision conflicts with a policy, the per-field decision wins and the rationale notes the deviation explicitly.

### P-1 — Shopify numeric IDs are wrapped to full GIDs at the boundary

Shopify webhook payloads carry resource IDs as integers (e.g., `"id": 12345`). Locked architectural decision #4 stores external Shopify IDs as **full GIDs** in the `shopifyXxxId` columns (e.g., `"gid://shopify/Customer/12345"`). The Order / Customer upsert function wraps the numeric to the GID at the boundary. A `toShopifyOrderGid(numeric)` / `toShopifyCustomerGid(numeric)` helper is added to `@winback/shopify` in session 1 alongside the existing `toCustomerGid` referenced in the schema header.

### P-2 — Money is parsed as BigInt cents

Shopify sends monetary amounts as JSON strings (e.g., `"total_price": "199.95"`). Locked architectural decision #2 stores money as `BigInt` cents. The repository parses each money string with a strict converter: `parseMoneyToCents("199.95") → 19995n`. Rejects non-numeric input, scientific notation, more than 2 decimal places. The converter lives in `@winback/db` (not `@winback/shopify`) because BigInt cents is a DB-layer concern.

### P-3 — Timestamps are parsed as `Date` (UTC)

Shopify sends timestamps as ISO 8601 strings (e.g., `"created_at": "2026-05-18T12:34:56-04:00"`). Stored as Prisma `DateTime` (Postgres `timestamptz` under the hood). Conversion: `new Date(isoString)` — JS handles the timezone offset, the DB stores in UTC per locked decision #3. Null on input → null on column.

### P-4 — `_set` money objects use `shop_money.amount` for shop-currency columns, `presentment_money.amount` for presentment columns

Several Order fields ship in two forms: a flat field (e.g., `total_price: "199.95"`) AND a `_set` object (`total_price_set: { shop_money: {amount, currency_code}, presentment_money: {amount, currency_code} }`). The `_set` form is authoritative — the flat field is a derived shop-currency value. The repository ALWAYS reads from the `_set` object when storing presentment fields; for shop-currency-only columns, the flat field is acceptable and shorter. Both must agree at parse time; we assert this in the parser and log a warning if they differ.

### P-5 — String enums are validated against the Prisma enum at boundary, unknown values reject

Shopify uses string enums for `financial_status`, `fulfillment_status`, `state`, etc. Each value is validated against the Prisma enum (`OrderFinancialStatus`, `OrderFulfillmentStatus`, `CustomerState`) at the parser layer. Unknown values → ZodError → drainer markFailed (retryable; Shopify may have added a new enum value we don't support yet, operator decides). This matches the existing schema pattern.

### P-6 — Tags

Shopify Customer ships `tags` as a comma-separated string (e.g., `"vip, repeat-buyer, loyal"`). Schema stores `Customer.tags` as `String[]`. The parser splits on `,`, trims each entry, drops empty strings. Order also ships `tags` as a string but the Order schema currently has **no tags column** (excluded — see Order field table).

### P-7 — Address objects (billing_address, shipping_address, customer.default_address, customer.addresses[]) are NOT denormalized into the existing tables

Order's `billing_address` and `shipping_address` and Customer's `default_address` / `addresses[]` are not currently stored in our schema. They're excluded from session 1 — rationale: not needed for RFM scoring, churn prediction, or the customer state machine. If campaign personalization (Epic F/G) needs city/country/region, a new `CustomerAddress` table lands then with a migration that backfills from the customers backfill runner. Session 1 reads the address fields off the webhook payload but does not persist them.

### P-8 — Deeply nested arrays (fulfillments[], refunds[], transactions[], discount_applications[], shipping_lines[], tax_lines[], note_attributes[], properties[], duties[])

Not stored in session 1 — see policy table below per field. These arrays carry operational data (shipping methods, individual tax breakdown, discount usage, fulfillment attempts, payment transactions) that doesn't enter RFM/churn/state-machine computation. If Epic F/G/H1 needs them, dedicated tables land in those epics. Session 1's parser allows them through `.passthrough()` so unknown payload structure doesn't reject ingestion, but does not extract or store individual entries.

### P-9 — Unknown fields (not enumerated in this doc) pass through

If Shopify adds a field in a future API version that isn't in this doc, the zod schema uses `.passthrough()` so it doesn't reject the webhook. We log at `debug` level (no operator alert — additive Shopify changes are routine). When we adopt that API version (currently pinned 2026-04), this doc gets updated with the new field's decision.

### P-10 — Customer reference in Order

The Order webhook embeds a `customer` object with the same shape as the Customer resource. The drainer's order handler treats it as a foreign-key reference: it looks up the local Customer by `(merchantId, shopifyCustomerId)` and writes `Order.customerId`. The embedded customer fields are NOT used to upsert the Customer row — `customers/create` / `customers/update` webhooks own that. If the order arrives for a customer we don't have locally yet (out-of-order webhook delivery, ref locked rule #22), `Order.customerId` is set to null and a debug log is emitted. Standing rule #22 ("Shopify webhook delivery is not ordered") makes this the correct behavior.

---

## Order webhook field mapping

71 top-level Order fields per the Shopify 2026-04 docs. Each is one of:
- **MAPPED** — existing schema column. Source field → target column noted.
- **NEW COLUMN (session 1)** — column doesn't exist; migration required this session.
- **EXCLUDED** — not stored; rationale given.

| # | Shopify field | Type | Decision | Target column / rationale |
|---|---|---|---|---|
| 1 | `id` | integer | MAPPED | → `Order.shopifyOrderId` (string, wrapped to GID per P-1) |
| 2 | `email` | string | EXCLUDED | Customer email lives on `Customer.email`; Order doesn't denormalize. Lookup via `Order.customerId` join. |
| 3 | `contact_email` | string | EXCLUDED | Same as `email`. Shopify's two-field convention (`email` = login email, `contact_email` = contact-only) doesn't affect us — we use Customer table. |
| 4 | `created_at` | string (ISO 8601) | MAPPED | → `Order.placedAt` per schema comment ("when the customer placed the order (Shopify created_at)"). Parsed per P-3. |
| 5 | `updated_at` | string (ISO 8601) | MAPPED | → `Order.shopifyUpdatedAt`. Parsed per P-3. Used for stale-data detection. |
| 6 | `processed_at` | string (ISO 8601) | NEW COLUMN (session 1) | → `Order.shopifyProcessedAt` (nullable `DateTime`). Distinct from `created_at` for draft orders converted to real orders later — `processed_at` is the customer-visible order date that Shopify's own analytics use for reporting. Session 2's RFM recency axis reads `shopifyProcessedAt ?? placedAt` so the fallback handles older orders or providers that don't set the field. Parsed per P-3. Nullable because not every order ships with the field populated (Shopify itself sometimes omits it on synchronous checkout flows). |
| 7 | `closed_at` | string (ISO 8601) | EXCLUDED | "Closed" is a fulfillment concept; we don't track Shopify's open/closed lifecycle, only financial + fulfillment status enums. |
| 8 | `cancelled_at` | string (ISO 8601) | MAPPED | → `Order.cancelledAt`. Parsed per P-3. |
| 9 | `cancel_reason` | string | EXCLUDED | Operational metadata; not used in RFM/churn. If Epic F/G campaign suppression needs it, schema migration then. |
| 10 | `name` | string | MAPPED | → `Order.shopifyOrderNumber`. Schema name retains "OrderNumber" wording; Shopify's `name` is the display name (e.g., `"#1001"`). Note schema column is mis-named per Shopify terminology but kept for backward compat. |
| 11 | `number` | integer | EXCLUDED | Internal Shopify sequence number; we use `name` for display, `shopifyOrderId` for keying. |
| 12 | `order_number` | integer | EXCLUDED | Display variant of `number` (with prefix offset for some shops); same reason as #11. |
| 13 | `confirmation_number` | string | EXCLUDED | Shopify-side customer-facing receipt code; not used in our domain. |
| 14 | `order_status_url` | string | EXCLUDED | Customer-facing Shopify URL; we don't surface this. |
| 15 | `token` | string | EXCLUDED | Shopify-internal order token; not used. |
| 16 | `cart_token` | string (deprecated) | EXCLUDED | Deprecated by Shopify. |
| 17 | `checkout_token` | string (deprecated) | EXCLUDED | Deprecated by Shopify. |
| 18 | `checkout_id` | string | EXCLUDED | Checkout-lifecycle metadata; not used. |
| 19 | `customer` | object | MAPPED (FK) | Embedded customer object → `Order.customerId` via local Customer lookup (P-10). Individual fields NOT used for upsert. |
| 20 | `billing_address` | object | EXCLUDED | Per P-7. |
| 21 | `shipping_address` | object | EXCLUDED | Per P-7. |
| 22 | `currency` | string | MAPPED | → `Order.currency` (Char(3)). Validated as 3-letter ISO 4217. |
| 23 | `presentment_currency` | string | MAPPED | → `Order.presentmentCurrency` (Char(3), nullable). |
| 24 | `subtotal_price` | string (money) | MAPPED | → `Order.subtotalAmountCents` (BigInt cents per P-2). Read from `subtotal_price_set.shop_money.amount` per P-4. |
| 25 | `subtotal_price_set` | object | MAPPED (composite) | Source for #24 (`shop_money.amount`). `presentment_money` not stored individually (only grand total has a presentment column per schema). |
| 26 | `total_price` | string (money) | MAPPED | → `Order.totalAmountCents` (BigInt). Source: `total_price_set.shop_money.amount`. |
| 27 | `total_price_set` | object | MAPPED (composite) | Source for #26 + `Order.presentmentTotalCents` (`presentment_money.amount`). |
| 28 | `total_tax` | string (money) | MAPPED | → `Order.totalTaxCents` (BigInt, default 0). Source: `total_tax_set.shop_money.amount`. |
| 29 | `total_tax_set` | object | MAPPED (composite) | Source for #28. |
| 30 | `total_discounts` | string (money) | MAPPED | → `Order.totalDiscountCents` (BigInt, default 0). Source: `total_discounts_set.shop_money.amount`. |
| 31 | `total_discounts_set` | object | MAPPED (composite) | Source for #30. |
| 32 | `total_line_items_price` | string (money) | EXCLUDED | Derivable as `subtotal_price + total_discounts`; redundant column. |
| 33 | `total_line_items_price_set` | object | EXCLUDED | Same as #32. |
| 34 | `total_outstanding` | string (money) | EXCLUDED | Outstanding balance is a payment-lifecycle concept; for RFM we only care about whether `financial_status = paid`. |
| 35 | `total_tip_received` | string (money) | EXCLUDED | Tips aren't used in RFM monetary calculation per the standard model; if Epic F prompt personalization wants this, add column then. |
| 36 | `total_shipping_price_set` | object | EXCLUDED | Shipping cost not separately tracked; subsumed by `total_price`. |
| 37 | `current_subtotal_price` | string (money) | EXCLUDED | "Current" variants reflect refund-adjusted totals; we use the original-order totals (`subtotal_price` etc.) and let `financial_status` indicate refund state. CP-2 attribution (H1) may need the current variants; revisit in H1. |
| 38 | `current_total_price` | string (money) | EXCLUDED | Same reasoning as #37. |
| 39 | `current_total_tax` | string (money) | EXCLUDED | Same. |
| 40 | `current_total_discounts` | string (money) | EXCLUDED | Same. |
| 41 | `current_total_duties_set` | object | EXCLUDED | Same + duties not used (Shopify's duties feature is for cross-border orders). |
| 42 | `original_total_duties_set` | object | EXCLUDED | Duties not used. |
| 43 | `total_duties` | string (money) | EXCLUDED | Duties not used. |
| 44 | `duties_included` | boolean | EXCLUDED | Duties not used. |
| 45 | `taxes_included` | boolean | EXCLUDED | Tax-inclusive pricing is a presentation concern; we store the totals as Shopify sends them and apply downstream logic to the `totalTaxCents` column directly. |
| 46 | `tax_exempt` | boolean | EXCLUDED | Order-level tax exemption is rare and operational; if needed, derivable from `total_tax = 0`. |
| 47 | `estimated_taxes` | boolean | EXCLUDED | Operational metadata; not used. |
| 48 | `tax_lines` | array | EXCLUDED | Per P-8. |
| 49 | `financial_status` | string | MAPPED | → `Order.financialStatus` (enum `OrderFinancialStatus`). Validated per P-5. Critical for CP-2 §Q1 qualifying-transition check. |
| 50 | `fulfillment_status` | string \| null | MAPPED | → `Order.fulfillmentStatus` (enum `OrderFulfillmentStatus`, nullable). Validated per P-5. |
| 51 | `fulfillments` | array | EXCLUDED | Per P-8. |
| 52 | `refunds` | array | EXCLUDED | Per P-8. CP-2 §Q2(d) handles refunds via marker fields on AttributionEvent (H1), not via storing refund records. |
| 53 | `transactions` | array | EXCLUDED | Per P-8. Payment transaction details not needed. |
| 54 | `line_items` | array | MAPPED (separate table) | → many `OrderLineItem` rows. See Order line items table below. |
| 55 | `discount_codes` | array | EXCLUDED | Per P-8 + not used in RFM (we measure outcome, not specific code). |
| 56 | `discount_applications` | array | EXCLUDED | Per P-8. |
| 57 | `shipping_lines` | array | EXCLUDED | Per P-8. |
| 58 | `payment_gateway_names` | array | EXCLUDED | Operational; not used. |
| 59 | `gateway` | string | EXCLUDED | Operational; not used. |
| 60 | `processing_method` | string | EXCLUDED | Operational; not used. |
| 61 | `payment_terms` | object | EXCLUDED | Operational; not used. |
| 62 | `note` | string | EXCLUDED | Free-form merchant notes; not used in our domain. |
| 63 | `note_attributes` | array | EXCLUDED | Per P-8. |
| 64 | `tags` | string (comma-sep) | EXCLUDED | Order tags are merchant-curated; if Epic F/G needs them, add a column then. (Customer tags ARE stored — different model.) |
| 65 | `phone` | string | EXCLUDED | Order-level phone is Shopify's SMS notification field; the canonical phone lives on Customer. |
| 66 | `buyer_accepts_marketing` | boolean | EXCLUDED | Marketing consent lives on the Customer's `email_marketing_consent.state`; per-order denormalization would drift. |
| 67 | `customer_locale` | string | EXCLUDED | Useful for Epic F prompt language selection; defer. |
| 68 | `landing_site` | string | EXCLUDED | Attribution-source metadata; CP-2 doesn't use it. If H1 attribution sources need it, schema migration then. |
| 69 | `referring_site` | string | EXCLUDED | Same as #68. |
| 70 | `source_name` | string | EXCLUDED | Order origin channel (`web`, `pos`, etc.); not used in our domain. |
| 71 | `source_identifier` | string | EXCLUDED | Same as #70. |
| 72 | `source_url` | string | EXCLUDED | Same as #70. |
| 73 | `location_id` | integer | EXCLUDED | POS location; not used. |
| 74 | `user_id` | integer | EXCLUDED | Staff user who created the order in admin; not used. |
| 75 | `app_id` | integer | EXCLUDED | The app that created the order; not used. |
| 76 | `browser_ip` | string | EXCLUDED | Privacy-sensitive; not stored. |
| 77 | `client_details` | object | EXCLUDED | Browser/session info; privacy-sensitive + not used. |
| 78 | `company` | object | EXCLUDED | B2B feature; not used. |
| 79 | `po_number` | string | EXCLUDED | B2B feature; not used. |
| 80 | `merchant_business_entity_id` | string | EXCLUDED | B2B feature; not used. |
| 81 | `test` | boolean | NEW COLUMN (session 1) | → `Order.isTest` (`Boolean @default(false)`). Test orders from a merchant's Shopify dev store would otherwise inflate RFM frequency scores. Session 2's RFM query filters `WHERE isTest = false`. Default `false` so the existing-Order backfill (none exists today, but if one ever runs) doesn't NULL-out the column. No new index — filter selectivity is small per merchant (a typical merchant has 0–5 test orders), so the existing `(merchantId, …)` indexes are sufficient. |
| 82 | `total_weight` | integer (grams) | EXCLUDED | Logistics field; not used. |

**Total: 82 enumerated Order fields. 13 MAPPED, 67 EXCLUDED, 2 NEW COLUMN (`shopifyProcessedAt`, `isTest` — see Schema-migration summary).**

### Order line items — `line_items[]` mapping

Each line_items[] entry is one `OrderLineItem` row. Schema reference: [packages/db/prisma/schema.prisma:572-602](packages/db/prisma/schema.prisma:572).

| # | Shopify field | Type | Decision | Target column / rationale |
|---|---|---|---|---|
| L1 | `id` | integer | MAPPED | → `OrderLineItem.shopifyLineItemId` (string, wrapped to GID per P-1) |
| L2 | `product_id` | integer \| null | MAPPED (FK) | → `OrderLineItem.productId` via local Product lookup by `(merchantId, shopifyProductId)`. Null if product not present locally (out-of-order delivery, deleted product). |
| L3 | `variant_id` | integer \| null | MAPPED (FK) | → `OrderLineItem.productVariantId` via local ProductVariant lookup by `(merchantId, shopifyVariantId)`. Null if variant not present locally. |
| L4 | `title` | string | MAPPED | → `OrderLineItem.title`. |
| L5 | `variant_title` | string | EXCLUDED | Subsumed by ProductVariant.title; if needed at display, join. |
| L6 | `name` | string | EXCLUDED | Concatenation of product + variant title; derivable. |
| L7 | `sku` | string | EXCLUDED | SKU lives on ProductVariant; not denormalized to line item. |
| L8 | `vendor` | string | EXCLUDED | Vendor lives on Product; not denormalized. |
| L9 | `quantity` | integer | MAPPED | → `OrderLineItem.quantity`. |
| L10 | `current_quantity` | integer | EXCLUDED | Refund-adjusted; same reasoning as #37 above (we store original quantity). |
| L11 | `price` | string (money) | MAPPED | → `OrderLineItem.unitPriceCents` (BigInt per P-2). Source: `price_set.shop_money.amount` per P-4. |
| L12 | `price_set` | object | MAPPED (composite) | Source for L11. |
| L13 | `grams` | integer | EXCLUDED | Logistics; not used. |
| L14 | `weight` | number | EXCLUDED | Logistics; not used. |
| L15 | `weight_unit` | string | EXCLUDED | Logistics; not used. |
| L16 | `requires_shipping` | boolean | EXCLUDED | Logistics; not used. |
| L17 | `taxable` | boolean | EXCLUDED | Tax categorization; not used per Order policy (we don't break out tax). |
| L18 | `gift_card` | boolean | EXCLUDED | Operational; not used (gift card orders pass through). |
| L19 | `fulfillment_status` | string \| null | EXCLUDED | Per-line fulfillment status; not tracked separately. Order-level `fulfillmentStatus` is the rollup. |
| L20 | `fulfillment_service` | string | EXCLUDED | Logistics; not used. |
| L21 | `fulfillable_quantity` | integer | EXCLUDED | Logistics; not used. |
| L22 | `total_discount` | string (money) | EXCLUDED | Per-line discount allocation; for RFM we use Order-level `totalDiscountCents`. |
| L23 | `total_discount_set` | object | EXCLUDED | Same as L22. |
| L24 | `properties` | array | EXCLUDED | Per P-8. Custom merchant properties on the line item. |
| L25 | `discount_allocations` | array | EXCLUDED | Per P-8. |
| L26 | `tax_lines` | array | EXCLUDED | Per P-8. |
| L27 | `origin_location` | object | EXCLUDED | Logistics; not used. |
| L28 | `duties` | array | EXCLUDED | Per P-8 + duties not used per Order policy. |
| L29 | `attributed_staffs` | array | EXCLUDED | Staff attribution; not used. |

`OrderLineItem.currency` is required by schema but not on the line item payload — sourced from `Order.currency` (the parent order's currency applies to all line items by Shopify's design).

**Total: 29 enumerated line item fields. 5 MAPPED (including 1 composite money source), 24 EXCLUDED.**

### Order's embedded `customer` object

Per P-10, the embedded customer object is treated as a foreign-key reference only. The drainer reads `customer.id`, wraps to GID, looks up local Customer by `(merchantId, shopifyCustomerId)`, sets `Order.customerId`. No individual fields are consumed. If `customer` is null (guest checkout — possible per Shopify), `Order.customerId` is set to null (schema permits — see [Order.customerId: String?](packages/db/prisma/schema.prisma:533)).

### Order's `billing_address` and `shipping_address` objects

Per P-7, fully excluded from session 1. The fields enumerated below are read by the parser (for passthrough/validation) but not stored.

| Field | Type | Decision |
|---|---|---|
| first_name | string | EXCLUDED (P-7) |
| last_name | string | EXCLUDED (P-7) |
| name | string | EXCLUDED (P-7) |
| company | string | EXCLUDED (P-7) |
| address1 | string | EXCLUDED (P-7) |
| address2 | string | EXCLUDED (P-7) |
| city | string | EXCLUDED (P-7) |
| province | string | EXCLUDED (P-7) |
| province_code | string | EXCLUDED (P-7) |
| country | string | EXCLUDED (P-7) |
| country_code | string | EXCLUDED (P-7) |
| zip | string | EXCLUDED (P-7) |
| phone | string | EXCLUDED (P-7) |
| latitude | string | EXCLUDED (P-7) |
| longitude | string | EXCLUDED (P-7) |

---

## Customer webhook field mapping

~25 top-level Customer fields per Shopify 2026-04 docs.

| # | Shopify field | Type | Decision | Target column / rationale |
|---|---|---|---|---|
| C1 | `id` | integer | MAPPED | → `Customer.shopifyCustomerId` (string, wrapped to GID per P-1). |
| C2 | `email` | string \| null | MAPPED | → `Customer.email` (nullable). |
| C3 | `phone` | string (E.164) | MAPPED | → `Customer.phone` (nullable). |
| C4 | `first_name` | string \| null | MAPPED | → `Customer.firstName` (nullable). |
| C5 | `last_name` | string \| null | MAPPED | → `Customer.lastName` (nullable). |
| C6 | `created_at` | string (ISO 8601) | MAPPED | → `Customer.shopifyCreatedAt`. Parsed per P-3. |
| C7 | `updated_at` | string (ISO 8601) | MAPPED | → `Customer.shopifyUpdatedAt`. Parsed per P-3. |
| C8 | `orders_count` | integer | MAPPED | → `Customer.ordersCount` (Int). Per schema header: "Cached from Shopify; never computed locally." |
| C9 | `state` | string (enum) | EXCLUDED | Shopify's customer-account state (`enabled` / `disabled` / `invited` / `declined`) is account-lifecycle metadata, **not** the same concept as our `Customer.state` (RFM-driven lifecycle: `active` / `warm` / `at_risk` / `dormant` / `lost`). The two enums collide by name. We do NOT overwrite our state column from Shopify's; ours is computed by Epic E session 2's scoring. Documented explicitly to prevent confusion. |
| C10 | `total_spent` | string (money) | EXCLUDED | Shopify aggregates this across all currencies and the value is meaningless for multi-currency stores (schema header line 44 explicitly drops `Customer.totalSpentCents` for this reason). Per-currency rollups land in Epic H. |
| C11 | `last_order_id` | integer \| null | EXCLUDED | We compute `lastOrderAt` from Order rows in session 2; no need to denormalize the order ID. |
| C12 | `last_order_name` | string \| null | EXCLUDED | Display value of #C11; not stored. |
| C13 | `note` | string | EXCLUDED | Merchant-curated free text; not used in RFM/churn. |
| C14 | `verified_email` | boolean | EXCLUDED | Account-trust signal; not used in our domain. If Epic G messaging needs to filter on this, add column then. |
| C15 | `multipass_identifier` | string | EXCLUDED | Multipass SSO identifier; not used. |
| C16 | `tax_exempt` | boolean | EXCLUDED | Tax operational; not used. |
| C17 | `tax_exemptions` | array | EXCLUDED | Same as C16. |
| C18 | `tags` | string (comma-sep) | MAPPED | → `Customer.tags` (`String[]`). Split + trim per P-6. |
| C19 | `currency` | string (deprecated) | EXCLUDED | Deprecated by Shopify (was the customer's last-order currency); use Order.currency. |
| C20 | `marketing_opt_in_level` | string | EXCLUDED | Subsumed by `email_marketing_consent.opt_in_level` (C22). |
| C21 | `accepts_marketing` | boolean (deprecated) | MAPPED (derived) | → `Customer.acceptsMarketing` (boolean). Source: `email_marketing_consent.state === 'subscribed'`. The legacy flat `accepts_marketing` field is not documented in 2026-04 docs (deprecated); we derive from C22. |
| C22 | `email_marketing_consent` | object | MAPPED (source for C21) | Read `state`, `opt_in_level`, `consent_updated_at`. `state` → derives `acceptsMarketing` per C21. The object's individual fields not separately stored. |
| C23 | `sms_marketing_consent` | object | MAPPED (derived) | Read `state` → derives `Customer.acceptsSms` (boolean): `state === 'subscribed'`. |
| C24 | `accepts_marketing_updated_at` | string (deprecated) | EXCLUDED | Deprecated; if we ever need consent timestamps, use `email_marketing_consent.consent_updated_at` directly. |
| C25 | `admin_graphql_api_id` | string | EXCLUDED | The GID — same value we derive from `id` (P-1). Don't store both. |
| C26 | `default_address` | object | EXCLUDED | Per P-7. |
| C27 | `addresses` | array (≤10) | EXCLUDED | Per P-7. |

**Total: 27 enumerated Customer fields. 11 MAPPED, 16 EXCLUDED. Zero NEW COLUMN.**

### Customer's `default_address` and `addresses[]` items

Per P-7, fully excluded from session 1. Field-by-field enumeration:

| Field | Type | Decision |
|---|---|---|
| id | integer | EXCLUDED (P-7) |
| customer_id | integer | EXCLUDED (P-7) |
| first_name | string | EXCLUDED (P-7) |
| last_name | string | EXCLUDED (P-7) |
| company | string | EXCLUDED (P-7) |
| address1 | string | EXCLUDED (P-7) |
| address2 | string | EXCLUDED (P-7) |
| city | string | EXCLUDED (P-7) |
| province | string | EXCLUDED (P-7) |
| country | string | EXCLUDED (P-7) |
| zip | string | EXCLUDED (P-7) |
| phone | string | EXCLUDED (P-7) |
| province_code | string | EXCLUDED (P-7) |
| country_code | string | EXCLUDED (P-7) |
| country_name | string | EXCLUDED (P-7) |
| default | boolean | EXCLUDED (P-7) |
| name | string | EXCLUDED (P-7) |

### Customer's `email_marketing_consent` object

Read by parser (source for C21). Individual fields are summarized below; only `state` is consumed.

| Field | Type | Decision |
|---|---|---|
| state | string (enum: `subscribed` / `not_subscribed` / `pending` / `unsubscribed` / `redacted`) | READ (derives C21) |
| opt_in_level | string (enum) | EXCLUDED — not used in session 1 |
| consent_updated_at | string (ISO 8601) | EXCLUDED — see C24 |

### Customer's `sms_marketing_consent` object

| Field | Type | Decision |
|---|---|---|
| state | string (enum same as email) | READ (derives `Customer.acceptsSms`) |
| opt_in_level | string | EXCLUDED |
| consent_updated_at | string | EXCLUDED |
| consent_collected_from | string | EXCLUDED |

---

## Schema-migration summary

**Session 1 introduces TWO new columns on `Order`:**

| Column | Type | Default | Reason |
|---|---|---|---|
| `Order.shopifyProcessedAt` | `DateTime?` | (null) | Authoritative customer-visible order date for RFM recency; `created_at` is a fallback only. See Order row #6. |
| `Order.isTest` | `Boolean` | `false` | Excludes merchant dev-store test orders from RFM frequency scoring. See Order row #81. |

Both columns are additive and non-breaking — safe to deploy ahead of the handler code (existing Order rows acquire null/false defaults). Single auto-style migration (no `CONCURRENTLY` needed for column additions on a young table). No new indexes — `isTest` selectivity is small per merchant; the existing `(merchantId, …)` composite indexes are sufficient for the RFM filter.

The migration file lands in the same PR as the handler code (session 1) — schema changes never ship without their consumer. Migration filename convention: `<timestamp>_epic_e_session_1_order_columns` per [packages/db/MIGRATIONS.md](packages/db/MIGRATIONS.md).

Two pre-existing schema notes worth flagging here so the implementer doesn't get surprised:

1. **`Order.shopifyOrderNumber` is mis-named** per Shopify terminology (`name` is the field that maps here, not `number`). Renaming would break existing consumers. Documented in row #10 of the Order table; column stays as-is.

2. **`Customer.state` enum (`active`/`warm`/`at_risk`/`dormant`/`lost`) collides by name with Shopify's `Customer.state` enum (`enabled`/`disabled`/`invited`/`declined`).** We DO NOT overwrite our state column from Shopify's. Documented in row #C9. The drainer's customer handler explicitly skips Shopify's `state` field. Session 2's scoring writer is the only thing that mutates `Customer.state`.

---

## Repository interface — proposed

These are the function signatures session 1 will deliver. Surfaced here so they can be locked alongside the field mapping.

```ts
// packages/db/src/repositories/order.repository.ts (new)
class OrderRepository {
  /**
   * Upsert an Order + its OrderLineItem rows from a Shopify webhook body.
   * Atomic — Order + LineItems in one tx. Idempotent on (merchantId, shopifyOrderId).
   *
   * Returns the upsert outcome + the qualifying-transition result for the
   * order.placed/order.updated → AttributionEvent path (per CP-2 §Q1). H1
   * will consume the qualifying result to write AttributionEvent; in
   * session 1 it's returned + logged but not acted on.
   */
  async upsertFromWebhook(args: {
    merchantId: string;
    body: ShopifyOrderWebhookBody;
    tx?: Prisma.TransactionClient;
  }): Promise<{
    orderId: string;
    isNewOrder: boolean;
    qualifyingTransition: 'paid_new' | 'paid_continued' | 'non_paid' | 'no_change';
    previousFinancialStatus: OrderFinancialStatus | null;
  }>;
}

// packages/db/src/repositories/customer.repository.ts (new)
class CustomerRepository {
  async upsertFromWebhook(args: {
    merchantId: string;
    body: ShopifyCustomerWebhookBody;
    tx?: Prisma.TransactionClient;
  }): Promise<{
    customerId: string;
    isNewCustomer: boolean;
  }>;

  async softDelete(args: {
    merchantId: string;
    shopifyCustomerId: string;
    tx?: Prisma.TransactionClient;
  }): Promise<{ existed: boolean }>;
}
```

Both repositories follow the existing `MerchantRepository` pattern: optional `tx` parameter for join-with-caller-transaction; scope assumed by the caller's `withTenantScope`.

Zod schemas for the webhook bodies live in `apps/drainer/src/payload-schemas.ts` (extending the post-C-1 base) and are tested in the drainer integration harness against producer-shaped fixtures matching this mapping.

---

## CP-2 §Q1 qualifying-transition — computed in session 1

**Decision (locked):** `OrderRepository.upsertFromWebhook` returns the qualifying-transition result. H1 reads it inline when writing AttributionEvent. Avoids a re-read in H1.

Return values:
- **`paid_new`**: new order arriving with `financial_status: paid` (orders/create path).
- **`paid_continued`**: existing order transitioned to `paid` from a non-paid status (orders/updated path; previous `Order.financialStatus` was NOT `paid`).
- **`non_paid`**: new or updated order with `financial_status` something other than `paid` — not an attribution trigger.
- **`no_change`**: orders/updated where `financial_status` didn't change OR was already `paid` (re-delivery, redundant update).

Only `paid_new` and `paid_continued` qualify for AttributionEvent insertion in H1. Session 1's order handler logs the qualifying result and exposes it on the repository return value; H1's commit adds the AttributionEvent write at the call site without a second DB read.

The accompanying `previousFinancialStatus: OrderFinancialStatus | null` field in the return signature is for H1's write — the AttributionEvent row records the transition's "from" state for audit/forensics. Read inside the same `prisma.$transaction` callback as the Order upsert so it can't drift.

---

## What's NOT in session 1's scope (deferred to later epics)

- **AttributionEvent table + writer** → H1 (per CP-2 §Q1)
- **Address storage** (`CustomerAddress` table or denormalized columns) → Epic F/G when campaign personalization needs region/country
- **Refund-adjusted current totals** (the `current_total_*` family) → Epic H if attribution needs them
- **Fulfillment / shipping / transaction detail** → not currently planned; epic TBD
- **Discount code analytics** → Epic G campaign reporting
- **Customer addresses[]** → Epic G messaging (region-based personalization)

---

## Audit checklist — before approving this doc

- [ ] Every top-level Order field (82 enumerated) has a decision row.
- [ ] Every top-level Customer field (27 enumerated) has a decision row.
- [ ] Every line_items[] field (29 enumerated) has a decision row.
- [ ] Address fields enumerated under the P-7 EXCLUDED policy with explicit list.
- [ ] Marketing consent objects' fields enumerated.
- [ ] Zero `rawPayload` escape hatch — every documented field has either MAPPED, NEW COLUMN, or EXCLUDED.
- [ ] All schema column references point to existing columns in [schema.prisma](packages/db/prisma/schema.prisma) — EXCEPT the two explicit NEW COLUMN entries (`Order.shopifyProcessedAt`, `Order.isTest`) listed in the Schema-migration summary. Confirm no implicit new columns hide in a MAPPED row.
- [ ] All money handling routed through P-2 (`parseMoneyToCents`).
- [ ] All timestamps routed through P-3 (`new Date(iso)`).
- [ ] All IDs routed through P-1 (numeric → GID wrap).
- [ ] Customer.state / Shopify state enum collision documented (C9).
- [ ] Qualifying-transition open question answered.

---

*This document is the source of truth for Shopify webhook → schema field mapping in Epic E session 1. Update in the same commit as any handler or repository change that affects field handling.*
