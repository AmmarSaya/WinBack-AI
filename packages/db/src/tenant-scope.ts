import { AsyncLocalStorage } from 'node:async_hooks';

import {
  ALL_SYSTEM_SCOPE_REASONS,
  type SystemScopeReason,
} from '@winback/contracts';

import { TenantScopeError } from './errors.js';

// ---------------------------------------------------------------------------
// Model classification
//
// Every model in the schema belongs to exactly one of four buckets. The
// extension dispatches on the bucket; getting the bucket wrong is a
// tenant-safety bug.
//
//   1. TENANT_SCOPED_MODELS         — most business tables. merchantId
//                                     mandatory on reads + writes.
//   2. TENANT_OPTIONAL_READ_MODELS  — forensic tables (FK SetNull on
//                                     Merchant delete). System-scope reads
//                                     may span tenants; writes still gated.
//   3. UNSCOPED_MODELS              — Shopify-adapter-owned. No tenant
//                                     concept (Session).
//   4. Merchant (handled by its own explicit branch in the extension)
//                                   — the tenant ROOT. Not in any set
//                                     because the semantics differ from
//                                     the other three: in tenant scope,
//                                     reads/writes must target the active
//                                     merchant (no merchantId field; the
//                                     `id` column IS the tenant). System
//                                     scope passes through.
//
// Adding a new model:
//   - business data → TENANT_SCOPED_MODELS
//   - audit/forensic data with FK SetNull → TENANT_OPTIONAL_READ_MODELS
//   - external-adapter table → UNSCOPED_MODELS
//   - a second tenant-root concept (unlikely) → new explicit branch
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
  'CustomerScore', // Epic E session 2 — per-customer RFM/state row
  'Product',
  'ProductVariant',
  'Order',
  'OrderLineItem',
  'OutboxEvent',
  'IdempotencyKey',
  'BackfillJob',   // Epic D — per-merchant backfill job rows. Added B1 2026-06-05 (audit L2-M1).
  'AiGeneration',  // Epic F batch 1 — one row per LLM call
  'Message',       // Epic F batch 1 — minimal draft row; Epic G extends
  'AiSpendBucket', // Epic F batch 1 — daily per-merchant LLM spend ledger
]);

/**
 * Forensic-retention tables: `merchantId` becomes nullable on Merchant
 * deletion (FK SetNull), preserving the row for compliance / debugging.
 *
 * Read gating: tenant scope behaves identically to TENANT_SCOPED_MODELS
 * (merchantId auto-injected and asserted). System scope bypasses the
 * tenant assertion, allowing operator dashboards and audit-trail queries
 * to span tenants.
 *
 * Write gating: identical to TENANT_SCOPED_MODELS in tenant scope —
 * merchantId is injected if absent, asserted if present, and explicit
 * `merchantId: null` is rejected. System scope writes pass through
 * unmodified, which is the ONLY path that can legally write `null` here.
 * (Example: `gdpr.shop_redact_idempotent` writes a tombstone AuditLog
 * row with `merchantId: null` from inside `withSystemScope`.)
 *
 * Test coverage for this gating lives in
 * `packages/db/tests/tenant-scope.test.ts` (`AuditLog write enforcement`
 * block); the gdpr-processor unit tests exercise the system-scope path.
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

// Hoist the AsyncLocalStorage onto `globalThis` so it survives Vite's
// module-reload mechanism. Vite serves modules via `eval at instantiateModule`
// and creates fresh module instances per request/transform cycle — each
// fresh instance would otherwise construct its own `AsyncLocalStorage`,
// breaking the contract that "withSystemScope sets the scope that the
// extension reads at the Prisma call site." The Prisma client (cached on
// globalThis in apps/web's db.server.ts) gets bound to ONE ALS at
// construction time; if a route's @winback/db import resolves to a
// different module instance with a different ALS, scopes set in the route
// are invisible to the extension and every read throws TenantScopeError.
//
// In production (no HMR, single module instantiation), this is effectively
// a no-op: the global is set once on first import and never re-resolved.
//
// Same pattern used for `__winbackPrisma` in apps/web/app/services/db.server.ts.
declare global {
  // eslint-disable-next-line no-var
  var __winbackScopeStore: AsyncLocalStorage<TenantScope> | undefined;
}

const scopeStore: AsyncLocalStorage<TenantScope> = (globalThis.__winbackScopeStore ??=
  new AsyncLocalStorage<TenantScope>());


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
 * and is typed against `SystemScopeReason` from `@winback/contracts` —
 * production code MUST reference a constant from `SYSTEM_SCOPE_REASONS`.
 * String literals are a type error at compile time.
 *
 * The system scope is NOT a free pass for application code. Use only at
 * system component boundaries. Application code should never see `kind: 'system'`.
 *
 * Test escape: integration tests use ad-hoc reasons prefixed `test.` for
 * scenario labelling (e.g. `test.cleanup`, `test.setup_merchant`). Those
 * don't belong in the production registry. The type signature accepts any
 * `test.${string}` template-literal so tests compile without polluting the
 * registry.
 *
 * Runtime regex is retained as belt-and-suspenders for callers that bypass
 * TS (e.g. `as never`, untyped JS, FFI). The two layers serve different
 * audiences: the union catches typos at compile time for typed callers,
 * the regex catches them at runtime for everyone else.
 *
 * Format examples that pass (TS + runtime):
 *   "outbox.drain"            (when registered)
 *   "shopify.install"
 *   "test.cleanup"            (test escape)
 *
 * Format examples that fail (TS rejects; if forced past with cast, regex also rejects):
 *   ""                  (empty)
 *   "system"            (no category.action)
 *   "Fix bug"           (uppercase + space)
 *   "tmp"               (no dot)
 *   "web.index.lookup"  (two dots — failed silently before step-2 lock; fixed)
 */
const SYSTEM_REASON_PATTERN = /^[a-z][a-z_]*\.[a-z][a-z_0-9]*$/;

export function withSystemScope<T>(
  reason: SystemScopeReason | `test.${string}`,
  fn: () => Promise<T>,
): Promise<T> {
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

/** Re-exported for tests and tooling that need the registered-reasons set. */
export { ALL_SYSTEM_SCOPE_REASONS };

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
