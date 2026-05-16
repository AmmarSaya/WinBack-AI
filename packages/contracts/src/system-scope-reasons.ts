/**
 * Canonical registry of `withSystemScope` reasons. System scope is the
 * cross-tenant escape hatch — every entry into it MUST justify itself with
 * a documented, greppable reason. This registry is that documentation.
 *
 * The reason string surfaces in logs and audit trails. A typo'd reason
 * passes the format regex but obscures which subsystem opened the scope,
 * defeating the auditability purpose. The typed union closes that gap.
 *
 * Naming convention (same as OUTBOX_EVENTS / AUDIT_ACTIONS — `<category>.<action>`
 * lowercase, underscores allowed):
 *
 *   shopify.install
 *   webhook.ingest
 *   gdpr.shop_redact
 *
 * The regex check in `withSystemScope` is retained as a runtime
 * belt-and-suspenders guard for callers that bypass TS (e.g. `// @ts-ignore`
 * or via untyped JS). The typed union is the primary enforcement.
 *
 * Adding a new reason:
 *   1. Add the constant here under the appropriate category.
 *   2. Use the constant at the call site — `withSystemScope` accepts only
 *      `SystemScopeReason`, not raw strings.
 *   3. The registry's exhaustive shape test will pass automatically.
 *
 * D1/D2 will add `outbox.drain`, `cron.idempotency_cleanup`, and similar
 * reasons. They are intentionally NOT pre-registered here — speculative
 * entries would dead-export and could mask a real wiring gap (a reason
 * exists but no caller uses it). When you arrive here as the D1/D2
 * author: add the new constant under a new (or existing) category below,
 * use it at the call site, and the exhaustive shape test in
 * `packages/contracts/tests/registries.test.ts` will pick it up.
 */

export const SYSTEM_SCOPE_REASONS = {
  /**
   * Token decrypt + token-revocation flows in @winback/shopify's
   * AdminClient / PrismaShopifyTokenResolver.
   */
  admin: {
    /** Decrypting a merchant's offline access token before an API call. */
    token_resolve: 'admin.token_resolve',
    /** Marking a merchant's token revoked after a 401 from Admin API. */
    token_revoke: 'admin.token_revoke',
  },
  /**
   * GDPR compliance handlers in @winback/db.
   */
  gdpr: {
    /** Full-shop GDPR erasure (Merchant + cascaded tenant data + Session). */
    shop_redact: 'gdpr.shop_redact',
  },
  /**
   * Outbox drainer (D2). The drainer worker calls
   * `OutboxRepository.claimBatch` across all tenants — system scope is
   * how it bypasses the tenant assertion in the Prisma extension.
   *
   * Note: the literal string `outbox.drain` is also registered as a
   * `QUEUE_NAMES.outbox.drain` queue name. Two different registries that
   * happen to share a string — coincidence, not coupling.
   */
  outbox: {
    drain: 'outbox.drain',
  },
  /**
   * Install flow in @winback/shopify. Required because no Merchant row
   * exists yet — the install IS the row-creating write.
   */
  shopify: {
    install: 'shopify.install',
  },
  /**
   * Webhook ingestion in apps/web. The ingest handler runs before tenant
   * resolution (HMAC verify → shop lookup → merchant lookup → tenant scope).
   */
  webhook: {
    ingest: 'webhook.ingest',
  },
  /** Health-check endpoints in apps/web that touch the DB pre-tenant. */
  healthcheck: {
    readyz: 'healthcheck.readyz',
  },
  /**
   * Pre-tenant lookups inside Remix routes (e.g. the index route resolves
   * the merchant by `shop` query param before binding a tenant scope).
   */
  web: {
    /**
     * NOTE: this entry was renamed from `web.index.lookup` (two dots) to
     * `web.index_lookup` (one dot) in the step-2 migration. The old value
     * silently failed the SYSTEM_REASON_PATTERN regex and would have
     * thrown TenantScopeError on the first request to `/`. No test
     * exercised that route, which is how the bug shipped to master.
     */
    index_lookup: 'web.index_lookup',
  },
} as const;

/**
 * Flat union of every system-scope reason — the type used as the parameter
 * of `withSystemScope`.
 */
export type SystemScopeReason =
  | (typeof SYSTEM_SCOPE_REASONS.admin)[keyof typeof SYSTEM_SCOPE_REASONS.admin]
  | (typeof SYSTEM_SCOPE_REASONS.gdpr)[keyof typeof SYSTEM_SCOPE_REASONS.gdpr]
  | (typeof SYSTEM_SCOPE_REASONS.outbox)[keyof typeof SYSTEM_SCOPE_REASONS.outbox]
  | (typeof SYSTEM_SCOPE_REASONS.shopify)[keyof typeof SYSTEM_SCOPE_REASONS.shopify]
  | (typeof SYSTEM_SCOPE_REASONS.webhook)[keyof typeof SYSTEM_SCOPE_REASONS.webhook]
  | (typeof SYSTEM_SCOPE_REASONS.healthcheck)[keyof typeof SYSTEM_SCOPE_REASONS.healthcheck]
  | (typeof SYSTEM_SCOPE_REASONS.web)[keyof typeof SYSTEM_SCOPE_REASONS.web];

/** Runtime Set of every registered reason, for shape tests + iteration. */
export const ALL_SYSTEM_SCOPE_REASONS: ReadonlySet<SystemScopeReason> = new Set([
  ...Object.values(SYSTEM_SCOPE_REASONS.admin),
  ...Object.values(SYSTEM_SCOPE_REASONS.gdpr),
  ...Object.values(SYSTEM_SCOPE_REASONS.outbox),
  ...Object.values(SYSTEM_SCOPE_REASONS.shopify),
  ...Object.values(SYSTEM_SCOPE_REASONS.webhook),
  ...Object.values(SYSTEM_SCOPE_REASONS.healthcheck),
  ...Object.values(SYSTEM_SCOPE_REASONS.web),
] as SystemScopeReason[]);

/**
 * Predicate. Used by `withSystemScope`'s runtime guard alongside the
 * regex check.
 */
export function isSystemScopeReason(value: string): value is SystemScopeReason {
  return ALL_SYSTEM_SCOPE_REASONS.has(value as SystemScopeReason);
}
