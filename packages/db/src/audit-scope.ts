import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Audit context — set at boundaries that perform sensitive operations so
 * subsequent writes can be tagged with `action`, `actorType`, `actorId`.
 *
 * B3 state: this ALS exists and is read by the extension for log-line
 * enrichment, but the extension does NOT auto-write AuditLog rows.
 * AuditLog rows are written by explicit calls to
 * `AuditLogRepository.append()` at the relevant call sites.
 *
 * Future (D2 outbox drainer): an `audit.entry` outbox event published in
 * the same transaction as the business write will materialize the AuditLog
 * row automatically — that's the correct compositional design. The current
 * shape of this module is forward-compatible.
 */

export interface AuditContext {
  /** Dotted action identifier, e.g. "merchant.uninstalled", "gdpr.customer_redact". */
  readonly action: string;
  readonly actorType: 'system' | 'merchant' | 'operator';
  readonly actorId?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  /** Safe-to-log metadata. NEVER put secrets here. */
  readonly context?: Readonly<Record<string, unknown>>;
}

const auditStore = new AsyncLocalStorage<AuditContext>();

export function withAudit<T>(ctx: AuditContext, fn: () => Promise<T>): Promise<T> {
  return auditStore.run(ctx, fn);
}

export function getAuditContext(): AuditContext | undefined {
  return auditStore.getStore();
}
