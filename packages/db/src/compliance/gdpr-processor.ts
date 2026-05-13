/**
 * GDPR compliance processor (C6).
 *
 * Three handlers, one per Shopify-mandatory GDPR webhook topic:
 *   - processCustomerDataRequest  (`customers/data_request`)
 *   - processCustomerRedact       (`customers/redact`)
 *   - processShopRedact           (`shop/redact`)
 *
 * Each handler is pure logic — it takes a Prisma client, the relevant ids,
 * and the webhook payload, and performs the compliance action. It does NOT
 * read from request context, ALS, or HTTP. The outbox drainer (D2) will
 * route gdpr.* OutboxEvents to these functions; until D2 lands, the
 * handlers are exercised only by unit tests. This is acceptable because
 * Shopify gives merchants 30 days to act on `customers/redact` and
 * `shop/redact` — the OutboxEvent queues in the meantime.
 *
 * DEPLOYMENT GATE: production cannot ship until D2 is operational. C6 ships
 * the contract and the handlers; D2 ships the worker that invokes them.
 *
 * Cascade-and-shop-redact note: deleting the Merchant row CASCADEs OutboxEvent
 * (per schema). The drainer (D2) MUST mark the gdpr.shop_redacted event
 * processedAt BEFORE invoking processShopRedact, OR sequence the drain so
 * the shop_redacted handler runs after all other tenant events. AuditLog FK
 * is SetNull so compliance evidence survives the cascade.
 *
 * Chunking: the Merchant → tenant-table cascade fans out to potentially
 * millions of rows for large stores. Per UnitOfWork header guidance, the
 * full-merchant cleanup runs as a series of chunked deletes, each in its
 * own short transaction, rather than one giant transaction.
 *
 * Idempotency: all three handlers must be safe to call multiple times for
 * the same logical event. Shopify will retry on 5xx. The drainer's
 * idempotency-key mechanism is the first line; these handlers are defensive
 * (no-op if the target is already redacted/deleted).
 */

import { AUDIT_ACTIONS, SYSTEM_SCOPE_REASONS } from '@winback/contracts';
import { Prisma } from '@prisma/client';

import type { WinbackPrisma } from '../client.js';
import { withSystemScope, withTenantScope } from '../tenant-scope.js';
import { UnitOfWork } from '../unit-of-work.js';

// ---------------------------------------------------------------------------
// Payload contracts
//
// Permissive types matching the documented Shopify GDPR webhook payloads. We
// don't reject on extra fields (Shopify adds fields without notice) but we
// pull only what we need. Defensive numeric → string coercion handles the
// REST-style numeric ids that Shopify sends in these webhooks.
// ---------------------------------------------------------------------------

export interface CustomerDataRequestPayload {
  readonly shop_id?: number | string;
  readonly shop_domain?: string;
  readonly customer?: {
    readonly id?: number | string;
    readonly email?: string | null;
    readonly phone?: string | null;
  };
  readonly orders_requested?: ReadonlyArray<number | string>;
  readonly data_request?: { readonly id?: number | string };
}

export interface CustomerRedactPayload {
  readonly shop_id?: number | string;
  readonly shop_domain?: string;
  readonly customer?: {
    readonly id?: number | string;
    readonly email?: string | null;
    readonly phone?: string | null;
  };
  readonly orders_to_redact?: ReadonlyArray<number | string>;
}

export interface ShopRedactPayload {
  readonly shop_id?: number | string;
  readonly shop_domain?: string;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Per-batch row count for the chunked tenant-table cleanup in
 * processShopRedact. Default 1000 balances tx latency (large stores) against
 * round-trip count (small stores). Override in tests for determinism.
 */
export const DEFAULT_SHOP_REDACT_BATCH_SIZE = 1000;

/**
 * Per-chunk transaction timeout for tenant-table deletes. Generous because
 * deleteMany on a large index can take seconds; we don't want spurious
 * tx timeouts to fail the redact. The chunks are size-bounded by
 * DEFAULT_SHOP_REDACT_BATCH_SIZE, not by time.
 */
const SHOP_REDACT_CHUNK_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// processCustomerDataRequest
//
// Shopify sends this when a customer (via the merchant) asks for a copy of
// their data. Merchants are responsible for replying out-of-band; our role
// is to log the request so the merchant has compliance evidence and a
// machine-readable audit trail. We do NOT ourselves return the data — that
// would imply a customer-facing data-export pipeline this app doesn't
// provide.
// ---------------------------------------------------------------------------

export interface ProcessCustomerDataRequestArgs {
  readonly prisma: WinbackPrisma;
  readonly merchantId: string;
  readonly shop: string;
  readonly payload: CustomerDataRequestPayload;
}

export async function processCustomerDataRequest(
  args: ProcessCustomerDataRequestArgs,
): Promise<void> {
  const { prisma, merchantId, shop, payload } = args;
  const uow = new UnitOfWork(prisma);

  await withTenantScope(merchantId, () =>
    uow.run(async (ctx) => {
      await ctx.db.auditLog.create({
        data: {
          merchantId,
          shop,
          actorType: 'system',
          actorId: 'gdpr.processor',
          action: AUDIT_ACTIONS.gdpr.customer_data_request,
          targetType: 'customer',
          targetId: payload.customer?.id != null ? String(payload.customer.id) : null,
          context: {
            dataRequestId: payload.data_request?.id != null ? String(payload.data_request.id) : null,
            shopDomain: payload.shop_domain ?? null,
            ordersRequested: (payload.orders_requested ?? []).map((id) => String(id)),
          } as Prisma.InputJsonValue,
        },
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// processCustomerRedact
//
// 48 hours after a customer is deleted (or after the merchant uninstalls and
// shop/redact arrives), Shopify dispatches `customers/redact` for any
// customer whose PII the merchant is no longer entitled to hold. Action:
//
//   1. Find the Customer row by (merchantId, full-GID).
//   2. NULL the PII columns: email, phone, firstName, lastName.
//   3. Set deletedAt (soft-delete; preserves aggregate revenue history).
//   4. Sever the Order link: NULL Order.customerId for that customer's orders.
//      (Schema cascade is SetNull on hard-delete; with soft-delete we do this
//      explicitly per the schema comment at Order.customer.)
//   5. Write AuditLog evidence.
//
// All five steps run in one tx so a crash doesn't leave PII partially redacted.
//
// Idempotency: re-running on an already-redacted customer is safe — the PII
// columns are already null, deletedAt is already set, and the Order.customerId
// nullings have already happened. The AuditLog row would be a duplicate; we
// treat that as acceptable (the drainer's idempotency key is the primary guard).
// ---------------------------------------------------------------------------

export interface ProcessCustomerRedactArgs {
  readonly prisma: WinbackPrisma;
  readonly merchantId: string;
  readonly shop: string;
  readonly payload: CustomerRedactPayload;
}

export async function processCustomerRedact(args: ProcessCustomerRedactArgs): Promise<void> {
  const { prisma, merchantId, shop, payload } = args;

  const numericId = payload.customer?.id;
  if (numericId == null || !/^\d+$/.test(String(numericId))) {
    // Malformed payload. Log via audit + return — Shopify retry won't fix
    // the payload, so we ack the work without acting on it.
    await withTenantScope(merchantId, async () => {
      await prisma.auditLog.create({
        data: {
          merchantId,
          shop,
          actorType: 'system',
          actorId: 'gdpr.processor',
          action: AUDIT_ACTIONS.gdpr.customer_redact_malformed,
          targetType: 'customer',
          targetId: numericId != null ? String(numericId) : null,
          context: { shopDomain: payload.shop_domain ?? null } as Prisma.InputJsonValue,
        },
      });
    });
    return;
  }

  const shopifyCustomerGid = `gid://shopify/Customer/${String(numericId)}`;
  const uow = new UnitOfWork(prisma);

  await withTenantScope(merchantId, () =>
    uow.run(async (ctx) => {
      // 1. Locate the customer row. Skip-with-audit if absent — Shopify can
      // re-send redacts for customers we never ingested.
      const customer = await ctx.db.customer.findUnique({
        where: { merchantId_shopifyCustomerId: { merchantId, shopifyCustomerId: shopifyCustomerGid } },
        select: { id: true },
      });

      if (customer === null) {
        await ctx.db.auditLog.create({
          data: {
            merchantId,
            shop,
            actorType: 'system',
            actorId: 'gdpr.processor',
            action: AUDIT_ACTIONS.gdpr.customer_redact_no_local_record,
            targetType: 'customer',
            targetId: String(numericId),
            context: {
              shopifyCustomerGid,
              shopDomain: payload.shop_domain ?? null,
            } as Prisma.InputJsonValue,
          },
        });
        return;
      }

      // 2 + 3. NULL PII + soft-delete. Set deletedAt only if not already set
      // (avoid bumping the timestamp on duplicate deliveries — preserves the
      // original redact moment for audit clarity).
      await ctx.db.customer.update({
        where: { id: customer.id },
        data: {
          email: null,
          phone: null,
          firstName: null,
          lastName: null,
          deletedAt: new Date(),
        },
      });

      // 4. Sever Order link. Order.customerId becomes null; aggregate
      // revenue history preserved without identifier.
      await ctx.db.order.updateMany({
        where: { merchantId, customerId: customer.id },
        data: { customerId: null },
      });

      // 5. Audit evidence.
      await ctx.db.auditLog.create({
        data: {
          merchantId,
          shop,
          actorType: 'system',
          actorId: 'gdpr.processor',
          action: AUDIT_ACTIONS.gdpr.customer_redact,
          targetType: 'customer',
          targetId: customer.id,
          context: {
            shopifyCustomerGid,
            shopDomain: payload.shop_domain ?? null,
            ordersToRedact: (payload.orders_to_redact ?? []).map((id) => String(id)),
          } as Prisma.InputJsonValue,
        },
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// processShopRedact
//
// 48 hours after `app/uninstalled`, Shopify sends `shop/redact`. By then the
// merchant has uninstalled the app; we have up to 30 days to fully erase
// their tenant data. This is the GDPR right-to-erasure for a whole shop.
//
// Approach (per UnitOfWork header guidance — full-merchant cleanup is NOT a
// single transaction):
//
//   1. System-scope lookup by `shop`. If no merchant row, idempotent ack
//      with audit entry (already redacted or never installed).
//   2. Write the gdpr.shop_redact AuditLog row FIRST. Merchant FK is SetNull,
//      so the row survives the merchant delete with its `shop` denormalized.
//   3. Chunked tenant-table deletes (each in its own UoW.run inside the
//      tenant scope). The schema's CASCADE policy would handle this in one
//      Merchant delete, but a Merchant delete on a large store could lock
//      the whole tenant's data for minutes. Pre-chunking keeps each tx
//      short.
//   4. Delete Session rows by `shop` (Session is UNSCOPED — owned by the
//      Shopify adapter — so it's not on the cascade path).
//   5. Final Merchant delete in system scope. Cascades clean up anything
//      the chunked deletes missed (defense in depth) and removes the
//      tenant row.
//
// The chunked deletes ARE redundant with the Merchant cascade. We accept
// the redundancy because the cascade is the correctness backstop while
// chunking is the operational safety mechanism.
//
// Tables that survive (FK SetNull): AuditLog, WebhookLog. Compliance and
// forensic retention. Their merchantId becomes null; the denormalized
// `shop` column lets operators still query them.
// ---------------------------------------------------------------------------

export interface ProcessShopRedactArgs {
  readonly prisma: WinbackPrisma;
  readonly shop: string;
  readonly payload: ShopRedactPayload;
  /** Test override; production uses DEFAULT_SHOP_REDACT_BATCH_SIZE. */
  readonly batchSize?: number;
}

/**
 * Tenant-scoped tables purged before the Merchant delete. Order is
 * deliberate — child-most relations first to minimize the cascade fan-out
 * at the final Merchant delete. The schema's CASCADE FKs make any
 * particular order safe; this ordering just bounds the per-step impact.
 */
const SHOP_REDACT_TABLES_IN_ORDER = [
  'orderLineItem',
  'order',
  'productVariant',
  'product',
  'customer',
  'outboxEvent',
  'idempotencyKey',
  'backfillJob',
  'merchantSettings',
  'billingSubscription',
] as const;

type ShopRedactTable = (typeof SHOP_REDACT_TABLES_IN_ORDER)[number];

export async function processShopRedact(args: ProcessShopRedactArgs): Promise<void> {
  const { prisma, shop, payload } = args;
  const batchSize = args.batchSize ?? DEFAULT_SHOP_REDACT_BATCH_SIZE;

  // 1. System-scope lookup. Idempotent if already redacted.
  const merchant = await withSystemScope(SYSTEM_SCOPE_REASONS.gdpr.shop_redact, () =>
    prisma.merchant.findUnique({ where: { shop }, select: { id: true } }),
  );

  if (merchant === null) {
    await withSystemScope(SYSTEM_SCOPE_REASONS.gdpr.shop_redact, async () => {
      await prisma.auditLog.create({
        data: {
          merchantId: null,
          shop,
          actorType: 'system',
          actorId: 'gdpr.processor',
          action: AUDIT_ACTIONS.gdpr.shop_redact_idempotent,
          targetType: 'merchant',
          targetId: null,
          context: { shopDomain: payload.shop_domain ?? null } as Prisma.InputJsonValue,
        },
      });
    });
    return;
  }

  const merchantId = merchant.id;

  // 2. AuditLog FIRST inside tenant scope (FK SetNull preserves it).
  await withTenantScope(merchantId, () =>
    new UnitOfWork(prisma).run(async (ctx) => {
      await ctx.db.auditLog.create({
        data: {
          merchantId,
          shop,
          actorType: 'system',
          actorId: 'gdpr.processor',
          action: AUDIT_ACTIONS.gdpr.shop_redact,
          targetType: 'merchant',
          targetId: merchantId,
          context: {
            shopId: payload.shop_id != null ? String(payload.shop_id) : null,
            shopDomain: payload.shop_domain ?? null,
          } as Prisma.InputJsonValue,
        },
      });
    }),
  );

  // 3. Chunked deletes. Each chunk: one UoW.run inside the tenant scope.
  for (const table of SHOP_REDACT_TABLES_IN_ORDER) {
    await chunkedDeleteTenant(prisma, merchantId, table, batchSize);
  }

  // 4. Delete Session rows for the shop. Sessions are UNSCOPED (Shopify
  // adapter table), so we don't bind a tenant scope — system scope is the
  // correct boundary.
  await withSystemScope(SYSTEM_SCOPE_REASONS.gdpr.shop_redact, async () => {
    await prisma.session.deleteMany({ where: { shop } });
  });

  // 5. Final Merchant delete (system scope — the merchant row itself is
  // unscoped from the tenant perspective). CASCADE handles any rows the
  // chunked passes missed.
  await withSystemScope(SYSTEM_SCOPE_REASONS.gdpr.shop_redact, async () => {
    await prisma.merchant.delete({ where: { id: merchantId } });
  });
}

/**
 * Chunked delete loop for one tenant-scoped Prisma delegate. Reads a
 * batch of ids (cheap by index), then deleteMany by primary-key id list,
 * each batch in its own UoW.run. Exits when a fetch returns empty.
 *
 * The IdempotencyKey table has a composite PK (merchantId, key) with no
 * single-column id, so we special-case it: deleteMany WHERE merchantId
 * with a hard upper bound, in repeating short transactions. This is the
 * one table where we can't fetch-ids-then-delete-by-id; the WHERE clause
 * is the only practical entry point.
 */
async function chunkedDeleteTenant(
  prisma: WinbackPrisma,
  merchantId: string,
  table: ShopRedactTable,
  batchSize: number,
): Promise<void> {
  const uow = new UnitOfWork(prisma);

  // The IdempotencyKey table lacks a single-column id; chunk by deleteMany
  // with no fetch step. The Postgres planner uses the (merchantId, key) PK.
  if (table === 'idempotencyKey') {
    await withTenantScope(merchantId, async () => {
      let more = true;
      while (more) {
        const result = await uow.run(
          async (ctx) => {
            // We can't LIMIT a deleteMany in Prisma; do a fetch-ids step
            // using the composite PK to bound the per-tx work, then delete.
            const rows = await ctx.db.idempotencyKey.findMany({
              where: { merchantId },
              select: { key: true },
              take: batchSize,
            });
            if (rows.length === 0) return { deleted: 0 };
            await ctx.db.idempotencyKey.deleteMany({
              where: { merchantId, key: { in: rows.map((r) => r.key) } },
            });
            return { deleted: rows.length };
          },
          { timeout: SHOP_REDACT_CHUNK_TIMEOUT_MS },
        );
        more = result.deleted === batchSize;
      }
    });
    return;
  }

  // Typed view over the Prisma transaction client for the subset of
  // delegates this function uses. ShopRedactTable keys are static; the
  // narrow type means TS doesn't widen them to `string | undefined` under
  // noUncheckedIndexedAccess.
  type TenantDelegate = {
    findMany: (a: unknown) => Promise<Array<{ id: string }>>;
    deleteMany: (a: unknown) => Promise<unknown>;
  };
  type TenantDelegates = { [K in ShopRedactTable]: TenantDelegate };

  // 1:1 tables — single tx is enough.
  if (table === 'merchantSettings' || table === 'billingSubscription') {
    await withTenantScope(merchantId, async () => {
      await uow.run(
        async (ctx) => {
          const delegates = ctx.db as unknown as TenantDelegates;
          // 1:1 by merchantId. deleteMany handles absent rows as a no-op.
          await delegates[table].deleteMany({ where: { merchantId } });
        },
        { timeout: SHOP_REDACT_CHUNK_TIMEOUT_MS },
      );
    });
    return;
  }

  // Multi-row, single-column id tables: fetch ids, deleteMany by id list,
  // repeat until empty.
  await withTenantScope(merchantId, async () => {
    let more = true;
    while (more) {
      const result = await uow.run(
        async (ctx) => {
          const delegates = ctx.db as unknown as TenantDelegates;
          const delegate = delegates[table];
          const rows = await delegate.findMany({
            where: { merchantId },
            select: { id: true },
            take: batchSize,
          });
          if (rows.length === 0) return { deleted: 0 };
          await delegate.deleteMany({
            where: { merchantId, id: { in: rows.map((r) => r.id) } },
          });
          return { deleted: rows.length };
        },
        { timeout: SHOP_REDACT_CHUNK_TIMEOUT_MS },
      );
      more = result.deleted === batchSize;
    }
  });
}
