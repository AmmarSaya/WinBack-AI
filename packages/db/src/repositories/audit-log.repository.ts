import { type AuditAction } from '@winback/contracts';
import { Prisma } from '@prisma/client';

import type { WinbackPrisma } from '../client.js';
import { getAuditContext } from '../audit-scope.js';

export interface AppendAuditLogInput {
  /** Tenant scope of the action; null only for cross-tenant operator ops. */
  readonly merchantId: string | null;
  /** Denormalized shop string — survives merchantId being nulled later. */
  readonly shop: string | null;
  readonly actorType: 'system' | 'merchant' | 'operator';
  readonly actorId?: string;
  /**
   * Typed audit-action identifier — must come from AUDIT_ACTIONS in
   * @winback/contracts. Raw string literals are a compile error here.
   * See ARCHITECTURE.md for the Audit Write Policy.
   */
  readonly action: AuditAction;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly context?: Record<string, unknown>;
}

/**
 * Explicit audit-log writer. Call from boundaries that perform sensitive
 * operations: GDPR redact handlers, billing actions, operator interventions,
 * merchant uninstall flows.
 *
 * `append` always succeeds in this layer — failures are caught and logged
 * but never thrown. This is intentional: a failed audit write should not
 * cancel the business operation that triggered it. The opposite policy
 * (audit-must-succeed-or-fail) is achievable by callers via try/catch
 * around the explicit `append` call.
 *
 * `appendFromContext` reads the active audit ALS context and appends with
 * those fields; convenience for code that's already inside a withAudit()
 * scope.
 */
export class AuditLogRepository {
  constructor(private readonly prisma: WinbackPrisma) {}

  async append(input: AppendAuditLogInput): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        merchantId: input.merchantId,
        shop: input.shop,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        // Prisma's nullable Json field requires `JsonNull` for explicit
        // null; `null` itself isn't part of `InputJsonValue`.
        context:
          input.context !== undefined
            ? (input.context as Prisma.InputJsonValue)
            : Prisma.JsonNull,
      },
    });
  }

  async appendFromContext(extra?: {
    merchantId?: string | null;
    shop?: string | null;
  }): Promise<void> {
    const ctx = getAuditContext();
    if (ctx === undefined) {
      throw new Error('appendFromContext called outside withAudit scope');
    }
    await this.append({
      merchantId: extra?.merchantId ?? null,
      shop: extra?.shop ?? null,
      actorType: ctx.actorType,
      ...(ctx.actorId !== undefined && { actorId: ctx.actorId }),
      action: ctx.action,
      ...(ctx.targetType !== undefined && { targetType: ctx.targetType }),
      ...(ctx.targetId !== undefined && { targetId: ctx.targetId }),
      ...(ctx.context !== undefined && { context: ctx.context as Record<string, unknown> }),
    });
  }
}
