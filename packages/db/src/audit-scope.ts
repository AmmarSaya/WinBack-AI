import { AsyncLocalStorage } from 'node:async_hooks';

import { type AuditAction } from '@winback/contracts';

/**
 * Audit context — set at boundaries that perform sensitive operations so
 * subsequent writes can be tagged with `action`, `actorType`, `actorId`.
 *
 * Audit Write Policy (see ARCHITECTURE.md): AuditLog rows are written
 * DIRECTLY in the same DB transaction as the business action they record.
 * They are NOT outbox-driven. The repository chokepoint is
 * `AuditLogRepository.append`, which accepts only `AuditAction` constants
 * from `@winback/contracts` — never raw strings.
 *
 * This module exists so audit context (actor, target, free-form metadata)
 * can be carried implicitly via AsyncLocalStorage when a caller is far
 * from the AuditLog write itself (e.g. operator dashboards, request
 * middleware). The explicit `AuditLogRepository.append` call remains the
 * write — `appendFromContext` is a convenience that reads from this ALS.
 */

export interface AuditContext {
  /** Typed audit action — must come from AUDIT_ACTIONS in @winback/contracts. */
  readonly action: AuditAction;
  readonly actorType: 'system' | 'merchant' | 'operator';
  readonly actorId?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  /** Safe-to-log metadata. NEVER put secrets here. */
  readonly context?: Readonly<Record<string, unknown>>;
}

// Hoisted onto globalThis to survive Vite HMR — same reason documented in
// detail in tenant-scope.ts. If two module copies each construct their own
// AsyncLocalStorage, the Prisma extension and the caller end up writing
// to / reading from different stores, and audit context goes silently
// missing in dev. Production is unaffected (single module instantiation).
declare global {
  // eslint-disable-next-line no-var
  var __winbackAuditStore: AsyncLocalStorage<AuditContext> | undefined;
}

const auditStore: AsyncLocalStorage<AuditContext> = (globalThis.__winbackAuditStore ??=
  new AsyncLocalStorage<AuditContext>());

export function withAudit<T>(ctx: AuditContext, fn: () => Promise<T>): Promise<T> {
  return auditStore.run(ctx, fn);
}

export function getAuditContext(): AuditContext | undefined {
  return auditStore.getStore();
}
