/**
 * Zod schemas for outbox event payloads consumed by the drainer.
 *
 * Each handler narrows `row.payload: unknown` through the matching schema
 * before acting. Parse failure → drainer dispatch catches and markFailed.
 *
 * The schemas mirror the producer-side TypeScript types (e.g. the GDPR
 * payload interfaces in `@winback/db`'s compliance module, the install.ts
 * outbox emission, etc.). When producers' shapes change, the version
 * suffix on the event type changes (`@v<n>`) and a new schema lands here.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// merchant.installed — emitted by completeInstall in @winback/shopify.
// Shape: { shop, scope, reinstall }. See packages/shopify/src/install.ts:95.
// ---------------------------------------------------------------------------

export const merchantInstalledPayloadSchema = z.object({
  shop: z.string().min(1),
  scope: z.string(),
  reinstall: z.boolean(),
});

export type MerchantInstalledPayload = z.infer<typeof merchantInstalledPayloadSchema>;

// ---------------------------------------------------------------------------
// GDPR payloads. Match the TypeScript interfaces exported from
// @winback/db/compliance (gdpr-processor.ts). Shopify's GDPR webhook
// bodies are passed through verbatim by the webhook ingest, so these
// schemas mirror Shopify's shape (numeric-or-string ids, snake_case keys).
//
// `shop_domain` is required by the schemas (not optional like the
// TypeScript types) because the drainer needs it to derive the `shop`
// arg for the compliance processors. Shopify reliably populates this
// field on every GDPR webhook; absence is an upstream contract violation
// worth surfacing via markFailed.
// ---------------------------------------------------------------------------

const numericOrString = z.union([z.number(), z.string()]);

const gdprCustomerNodeSchema = z
  .object({
    id: numericOrString.optional(),
    email: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
  })
  .optional();

export const customerDataRequestPayloadSchema = z.object({
  shop_id: numericOrString.optional(),
  shop_domain: z.string().min(1),
  customer: gdprCustomerNodeSchema,
  orders_requested: z.array(numericOrString).optional(),
  data_request: z.object({ id: numericOrString.optional() }).optional(),
});

export const customerRedactPayloadSchema = z.object({
  shop_id: numericOrString.optional(),
  shop_domain: z.string().min(1),
  customer: gdprCustomerNodeSchema,
  orders_to_redact: z.array(numericOrString).optional(),
});

export const shopRedactPayloadSchema = z.object({
  shop_id: numericOrString.optional(),
  shop_domain: z.string().min(1),
});

// ---------------------------------------------------------------------------
// order.* — producer is the webhook ingest at apps/web/app/services/
// webhook-ingest.server.ts:142-154, which writes `{ topic, webhookId, body }`
// where `body` is the raw Shopify webhook payload. The handler is a
// pre-Epic-E stub (see handlers/order.ts header); body validation is loose
// because the real Order upsert + qualifying-transition check (per CP-2
// §Q1) lives in Epic E / H1, not here. Keeping `body.id` typed as
// `number | string | undefined` mirrors what Shopify actually sends
// without over-constraining the rest of the body shape — additional
// Shopify fields pass through unaffected.
// ---------------------------------------------------------------------------

export const orderEventPayloadSchema = z
  .object({
    topic: z.enum(['orders/create', 'orders/updated']),
    webhookId: z.string().min(1),
    body: z
      .object({
        id: z.union([z.number(), z.string()]).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type OrderEventPayload = z.infer<typeof orderEventPayloadSchema>;
