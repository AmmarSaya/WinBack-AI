import { AsyncLocalStorage } from 'node:async_hooks';

import { TenantScopeError } from './errors.js';

// ---------------------------------------------------------------------------
// Model classification
// ---------------------------------------------------------------------------

/**
 * Models with mandatory `merchantId` on reads AND writes. The extension
 * auto-injects from the active tenant scope and rejects any query that
 * targets a different merchant.
 */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set([
  'MerchantSettings',
  'BillingSubscription',
  'Customer',
  'Product',
  'ProductVariant',
  'Order',
  'OrderLineItem',
  'OutboxEvent',
  'IdempotencyKey',
]);

/**
 * Models with OPTIONAL tenant scoping on reads. System-scope reads may span
 * tenants (operator dashboards, audit trails). Writes still require a
 * tenant scope.
 */
export const TENANT_OPTIONAL_READ_MODELS: ReadonlySet<string> = new Set([
  'WebhookLog',
  'AuditLog',
]);

/**
 * Models with soft-delete semantics. The extension auto-injects
 * `where: { deletedAt: null }` on reads unless the caller explicitly sets
 * `deletedAt` in the where clause.
 */
export const SOFT_DELETE_MODELS: ReadonlySet<string> = new Set([
  'Customer',
  'Product',
  'ProductVariant',
]);

/**
 * Models that are entirely outside tenancy enforcement (Shopify-adapter-owned,
 * unscoped fixtures, etc.). The extension passes their queries through
 * untouched.
 */
export const UNSCOPED_MODELS: ReadonlySet<string> = new Set(['Session']);

// ---------------------------------------------------------------------------
// Scope ALS
// ---------------------------------------------------------------------------

export type TenantScope =
  | { readonly kind: 'tenant'; readonly merchantId: string }
  | { readonly kind: 'system'; readonly reason: string };

const scopeStore = new AsyncLocalStorage<TenantScope>();

/**
 * Runs `fn` inside a tenant scope. Every db operation inside (and in any
 * awaited descendant) is bound to `merchantId` — the extension auto-injects
 * and rejects cross-tenant access.
 *
 * Use at:
 *   - HTTP handler entry, post-auth.
 *   - Webhook ingestion handler entry.
 *   - Queue worker job entry (re-bind from job payload).
 *
 * Nested calls with the SAME merchantId are allowed (no-op rebind).
 * Nested calls with a DIFFERENT merchantId throw.
 */
export function withTenantScope<T>(merchantId: string, fn: () => Promise<T>): Promise<T> {
  const parent = scopeStore.getStore();
  if (parent !== undefined && parent.kind === 'tenant' && parent.merchantId !== merchantId) {
    return Promise.reject(
      new TenantScopeError(
        `Nested tenant scope mismatch: outer=${parent.merchantId}, inner=${merchantId}`,
      ),
    );
  }
  return scopeStore.run({ kind: 'tenant', merchantId }, fn);
}

/**
 * Runs `fn` in system scope. Required for legitimate cross-tenant operations
 * (cron sweeps, operator tooling, outbox drainer). `reason` is mandatory
 * AND must match `category.action` format (lowercase, dotted) — forces
 * every system-scope entry to document WHY it's bypassing tenancy in a
 * greppable form. The reason surfaces in logs and audit trails.
 *
 * The system scope is NOT a free pass for application code. Use only at
 * system component boundaries. Application code should never see `kind: 'system'`.
 *
 * Format examples that pass:
 *   "outbox.drain"
 *   "cron.idempotency_cleanup"
 *   "shopify.install"
 *   "operator.admin_query"
 *
 * Format examples that fail:
 *   ""                  (empty)
 *   "system"            (no category.action)
 *   "Fix bug"           (uppercase + space)
 *   "tmp"               (no dot)
 */
const SYSTEM_REASON_PATTERN = /^[a-z][a-z_]*\.[a-z][a-z_0-9]*$/;

export function withSystemScope<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  if (typeof reason !== 'string' || !SYSTEM_REASON_PATTERN.test(reason)) {
    return Promise.reject(
      new TenantScopeError(
        `withSystemScope reason must match format "category.action" ` +
          `(lowercase, optional underscores/digits). Got: ${JSON.stringify(reason)}`,
      ),
    );
  }
  return scopeStore.run({ kind: 'system', reason }, fn);
}

/**
 * Reads the current scope. Returns `undefined` if no scope is active.
 *
 * The extension uses this to inject/assert; application code should NOT
 * read it directly — the scope is enforced at the query layer, not in
 * business logic.
 */
export function getTenantScope(): TenantScope | undefined {
  return scopeStore.getStore();
}

/**
 * Convenience for repository methods: assert that the caller's claimed
 * `merchantId` matches the active scope, OR the scope is `system`. Throws
 * `TenantScopeError` on mismatch.
 *
 * Used by raw-SQL helpers in repositories (the extension can't see raw
 * `$queryRaw` calls, so repositories must explicitly assert).
 */
export function assertScopeMatchesMerchant(merchantId: string): void {
  const scope = scopeStore.getStore();
  if (scope === undefined) {
    throw new TenantScopeError(
      `Operation on merchant=${merchantId} attempted with no active scope.`,
    );
  }
  if (scope.kind === 'system') return;
  if (scope.merchantId !== merchantId) {
    throw new TenantScopeError(
      `Tenant scope mismatch: scope=${scope.merchantId}, claimed=${merchantId}`,
    );
  }
}
