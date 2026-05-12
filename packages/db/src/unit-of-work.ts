import { OUTBOX_EVENTS, type OutboxEventType } from '@winback/contracts';
import { type Prisma } from '@prisma/client';

import type { WinbackPrisma } from './client.js';
import { TenantScopeError } from './errors.js';
import { getTenantScope } from './tenant-scope.js';

// ---------------------------------------------------------------------------
// Defaults — exposed so callers can reference them when deciding overrides.
// ---------------------------------------------------------------------------

export const UNIT_OF_WORK_DEFAULTS = {
  /** Max time to wait for a free DB connection / transaction slot. */
  maxWaitMs: 2_000,
  /** Max time the transaction can stay open before forced rollback. */
  timeoutMs: 5_000,
} as const;

export interface UnitOfWorkOptions {
  /** Override default maxWait. See UNIT_OF_WORK_DEFAULTS.maxWaitMs. */
  readonly maxWait?: number;
  /** Override default timeout. See UNIT_OF_WORK_DEFAULTS.timeoutMs. */
  readonly timeout?: number;
}

/**
 * Per-call-site guidance for `timeout` overrides:
 *
 *   - Outbox write + business write:           defaults (5s / 2s)
 *   - Webhook ingestion handler:               defaults
 *   - Shopify backfill page processor:         timeout: 30_000
 *   - Bulk state transition (chunked):         timeout: 60_000, one tx per chunk
 *   - Full-merchant GDPR / uninstall cleanup:  NOT a single transaction —
 *                                              chunked deletes, each in its
 *                                              own UnitOfWork.run.
 *
 * Raising the default for everyone is the wrong move. It masks transactions
 * that should have been redesigned. Override consciously at the call site.
 */

// ---------------------------------------------------------------------------
// Transaction client behavior inside extensions
//
// In Prisma 5.x, calling `$transaction` on an EXTENDED client propagates
// the extension to the tx callback parameter at runtime — i.e., the tx
// client DOES fire our hooks (tenant assertion, soft-delete, AiTone
// validation). The TS type of the callback parameter is, however, the
// non-extended `Prisma.TransactionClient` (a known Prisma typing gap).
//
// Practical implication: callers inside UnitOfWork.run benefit from the
// runtime hooks but lose extension-specific TYPE additions. None of our
// current hooks add new methods/result fields, so this is a TS-ergonomics
// issue, not a safety gap. Documented; revisit if Prisma improves the
// callback typing.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// UnitOfWorkContext
// ---------------------------------------------------------------------------

export class UnitOfWorkContext {
  constructor(
    private readonly tx: Prisma.TransactionClient,
    private readonly merchantId: string,
  ) {}

  /** The transaction-scoped Prisma client. */
  get db(): Prisma.TransactionClient {
    return this.tx;
  }

  /** Active merchant id for the transaction. */
  get tenant(): string {
    return this.merchantId;
  }

  /**
   * Append an outbox event in the same transaction as the business write.
   *
   * The event is delivered to BullMQ by the outbox drainer worker (D2).
   * Callers reference `type` from `@winback/contracts` `OUTBOX_EVENTS`:
   *
   *   ctx.publish(OUTBOX_EVENTS.order.placed, { orderId, totalCents });
   *
   * Never pass a string literal for `type` — the typed registry is the
   * only source of valid event names.
   */
  async publish(type: OutboxEventType, payload: Record<string, unknown>): Promise<void> {
    await this.tx.outboxEvent.create({
      data: {
        merchantId: this.merchantId,
        type,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// UnitOfWork
// ---------------------------------------------------------------------------

export class UnitOfWork {
  constructor(private readonly prisma: WinbackPrisma) {}

  /**
   * Runs `fn` inside a DB transaction. The callback receives a
   * `UnitOfWorkContext` bundling the transaction-scoped client and an
   * outbox-publish helper bound to the active tenant.
   *
   * Requires an active tenant scope (`withTenantScope`). System scope is
   * NOT allowed here — transactional outbox writes are always tenant-scoped.
   * Cross-tenant system operations use `prisma.$transaction` directly with
   * explicit per-row tenant fields; outbox publish is meaningless there.
   *
   * Default timeout is `UNIT_OF_WORK_DEFAULTS.timeoutMs` (5s). Backfill
   * and bulk callers MUST override per call-site — see guidance above this
   * class.
   */
  async run<T>(
    fn: (ctx: UnitOfWorkContext) => Promise<T>,
    options: UnitOfWorkOptions = {},
  ): Promise<T> {
    const scope = getTenantScope();
    if (scope === undefined || scope.kind !== 'tenant') {
      throw new TenantScopeError(
        'UnitOfWork.run requires an active tenant scope (withTenantScope).',
      );
    }
    const merchantId = scope.merchantId;

    return this.prisma.$transaction(
      async (tx) => fn(new UnitOfWorkContext(tx as Prisma.TransactionClient, merchantId)),
      {
        maxWait: options.maxWait ?? UNIT_OF_WORK_DEFAULTS.maxWaitMs,
        timeout: options.timeout ?? UNIT_OF_WORK_DEFAULTS.timeoutMs,
      },
    );
  }
}

// Re-export the typed event registry so callers don't need a second import.
export { OUTBOX_EVENTS, type OutboxEventType };
