/**
 * Canonical registry of outbox event types. Every producer MUST reference a
 * constant from this object — never a string literal. Adding a new event is
 * a TS-only change here; the DB CHECK constraint (T4) validates format but
 * not membership, so this registry is the only enforcement of the closed
 * event set.
 *
 * Naming convention (enforced by T4 regex):
 *   <domain>.<event>@v<n>
 *   - domain: lowercase, may contain underscores
 *   - event:  lowercase, may contain underscores/digits
 *   - @v<n>:  optional version suffix; omit for v1, required from v2 onward
 *
 * Versioning rule: a payload-shape change MUST bump the @v<n> suffix.
 * Consumers handle multiple versions or drop unsupported ones.
 *
 * Audit is intentionally NOT a domain here. Per the Audit Write Policy in
 * ARCHITECTURE.md, AuditLog rows are written directly in the same DB
 * transaction as the business action they record — never through the
 * outbox. See AUDIT_ACTIONS in this package for the typed registry of
 * AuditLog.action values.
 */

export const OUTBOX_EVENTS = {
  merchant: {
    installed: 'merchant.installed',
    uninstalled: 'merchant.uninstalled',
    needs_reauth: 'merchant.needs_reauth',
    shop_details_fetched: 'merchant.shop_details_fetched',
    backfill_completed: 'merchant.backfill_completed',
  },
  customer: {
    created: 'customer.created',
    updated: 'customer.updated',
    deleted: 'customer.deleted',
    redacted: 'customer.redacted',
    state_changed: 'customer.state_changed',
  },
  order: {
    placed: 'order.placed',
    updated: 'order.updated',
    cancelled: 'order.cancelled',
    refunded: 'order.refunded',
  },
  product: {
    created: 'product.created',
    updated: 'product.updated',
    deleted: 'product.deleted',
  },
  // GDPR compliance (C6). Emitted by webhook-ingest when a GDPR topic
  // arrives; consumed by the compliance processor in @winback/db. Per
  // Shopify, merchants have a 30-day SLA on redact actions — the processor
  // does not need to run synchronously inside the webhook handler.
  //
  // shop_redacted note: deleting the Merchant row CASCADEs OutboxEvent for
  // that tenant. The drainer (D2) MUST mark the event processedAt BEFORE
  // invoking processShopRedact, OR run the shop_redacted handler last in
  // a per-tenant pass. AuditLog rows have FK SetNull so the compliance
  // trail survives the cascade.
  gdpr: {
    customer_data_requested: 'gdpr.customer_data_requested',
    customer_redacted: 'gdpr.customer_redacted',
    shop_redacted: 'gdpr.shop_redacted',
  },
} as const;

// Flat union of every event type literal — the type used for OutboxEvent.type
// and as the parameter type of UnitOfWork's `publish`.
export type OutboxEventType =
  | (typeof OUTBOX_EVENTS.merchant)[keyof typeof OUTBOX_EVENTS.merchant]
  | (typeof OUTBOX_EVENTS.customer)[keyof typeof OUTBOX_EVENTS.customer]
  | (typeof OUTBOX_EVENTS.order)[keyof typeof OUTBOX_EVENTS.order]
  | (typeof OUTBOX_EVENTS.product)[keyof typeof OUTBOX_EVENTS.product]
  | (typeof OUTBOX_EVENTS.gdpr)[keyof typeof OUTBOX_EVENTS.gdpr];

// Convenience: all event types as a runtime Set for validation / iteration.
export const ALL_OUTBOX_EVENT_TYPES: ReadonlySet<OutboxEventType> = new Set([
  ...Object.values(OUTBOX_EVENTS.merchant),
  ...Object.values(OUTBOX_EVENTS.customer),
  ...Object.values(OUTBOX_EVENTS.order),
  ...Object.values(OUTBOX_EVENTS.product),
  ...Object.values(OUTBOX_EVENTS.gdpr),
] as OutboxEventType[]);
