/**
 * Canonical registry of AuditLog.action values. Every writer of `AuditLog`
 * MUST reference a constant from this object — never a string literal.
 *
 * Naming convention (same as OUTBOX_EVENTS — `<domain>.<action>` lowercase,
 * underscores allowed, optional `@v<n>` suffix on payload changes):
 *
 *   gdpr.customer_redact
 *   gdpr.shop_redact_idempotent
 *
 * There is no DB CHECK constraint on AuditLog.action — this registry plus
 * the typed write chokepoint in `AuditLogRepository` are the enforcement.
 * Free-form strings at the DB layer would be a typo-into-production hazard.
 *
 * Why this is a separate registry from OUTBOX_EVENTS: per the Audit Write
 * Policy in ARCHITECTURE.md, AuditLog rows are written DIRECTLY in the
 * same DB transaction as the business action they record — never via the
 * outbox. The two registries describe two different write paths.
 *
 * Adding a new action:
 *   1. Add the constant here under the appropriate domain (or create a new
 *      domain if it's the first action of a category).
 *   2. Use the constant at the call site — `AuditLogRepository.append`
 *      accepts only `AuditAction`, not raw strings.
 *   3. The registry's exhaustive shape test (packages/contracts/tests/
 *      registries.test.ts) will pass automatically.
 */

export const AUDIT_ACTIONS = {
  gdpr: {
    /** Customer (or merchant) requested a copy of their data. */
    customer_data_request: 'gdpr.customer_data_request',
    /** Customer PII NULL-ed and Customer row soft-deleted. */
    customer_redact: 'gdpr.customer_redact',
    /** customers/redact webhook arrived with a malformed customer.id. */
    customer_redact_malformed: 'gdpr.customer_redact_malformed',
    /** customers/redact webhook for a customer we never ingested. */
    customer_redact_no_local_record: 'gdpr.customer_redact_no_local_record',
    /** Shop fully redacted (Merchant row + all tenant data deleted). */
    shop_redact: 'gdpr.shop_redact',
    /** shop/redact webhook for a merchant already gone (idempotent ack). */
    shop_redact_idempotent: 'gdpr.shop_redact_idempotent',
  },
} as const;

/**
 * Flat union of every audit-action literal — the type used for
 * `AuditLog.action`, `AppendAuditLogInput.action`, and `AuditContext.action`.
 */
export type AuditAction = (typeof AUDIT_ACTIONS.gdpr)[keyof typeof AUDIT_ACTIONS.gdpr];

/** Runtime Set of every registered action, for shape tests + iteration. */
export const ALL_AUDIT_ACTIONS: ReadonlySet<AuditAction> = new Set([
  ...Object.values(AUDIT_ACTIONS.gdpr),
] as AuditAction[]);

/**
 * Predicate. Useful for inputs that are typed `string` at a boundary
 * (e.g. CLI args, untrusted API params) before they cross into the
 * AuditAction-typed code path.
 */
export function isAuditAction(value: string): value is AuditAction {
  return ALL_AUDIT_ACTIONS.has(value as AuditAction);
}
