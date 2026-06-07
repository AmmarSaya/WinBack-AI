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

import type { WinbackPrisma } from '../client.js';
import { AuditLogRepository } from '../repositories/audit-log.repository.js';
import { MerchantRepository } from '../repositories/merchant.repository.js';
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
  readonly orders_requested?: readonly (number | string)[];
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
  readonly orders_to_redact?: readonly (number | string)[];
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
  const auditLog = new AuditLogRepository(prisma);

  await withTenantScope(merchantId, async () => {
    await uow.run(async (ctx) => {
      await auditLog.append(
        {
          merchantId,
          shop,
          actorType: 'system',
          actorId: 'gdpr.processor',
          action: AUDIT_ACTIONS.gdpr.customer_data_request,
          targetType: 'customer',
          ...(payload.customer?.id != null && { targetId: String(payload.customer.id) }),
          context: {
            dataRequestId: payload.data_request?.id != null ? String(payload.data_request.id) : null,
            shopDomain: payload.shop_domain ?? null,
            ordersRequested: (payload.orders_requested ?? []).map((id) => String(id)),
          },
        },
        ctx.db,
      );
    });
  });
}

// ---------------------------------------------------------------------------
// processCustomerRedact (B2 — closes L3-H1, L4-M3, L4-H1 mock-mirror)
//
// 48 hours after a customer is deleted (or after the merchant uninstalls and
// shop/redact arrives), Shopify dispatches `customers/redact` for any
// customer whose PII the merchant is no longer entitled to hold. Action:
//
//   1. Find the Customer row by (merchantId, full-GID).
//   2. NULL the PII columns: email, phone, firstName, lastName.
//   3. Replace shopifyCustomerId with a redaction sentinel
//      (`redacted:<customer.id>` — the customer's own globally-unique cuid
//      PK reused as entropy; preserves the NOT NULL + composite-unique
//      constraint while making the row un-attributable from the GID). The
//      original GID is gone from the Customer row; re-identification would
//      require the AuditLog `context.shopifyCustomerGid` field, which is
//      retained as GDPR-required compliance evidence.
//   4. Set deletedAt — ONLY if currently null (preserves the original redact
//      moment per the L4-M3 invariant; duplicate deliveries don't bump it).
//   5. Sever the Order link: NULL Order.customerId for that customer's orders.
//      (Schema cascade is SetNull on hard-delete; with soft-delete on
//      Customer we do this explicitly per the Order.customer schema comment.)
//   6. Hard-delete the Customer-CASCADE children listed in
//      CUSTOMER_REDACT_CHILD_TABLES (Message + AiGeneration + CustomerScore,
//      FK-safe child-first order). The PII embedded in AI text columns
//      (firstName in prompts; generatedText addressed by name) is removed
//      by row-level deletion, not column-level scrub — there's nothing to
//      drift on per new PII column. Each deleteMany is scoped
//      { merchantId, customerId } — the merchantId scope is the
//      cross-tenant-bleed guard (the same Shopify customer at two merchants
//      must be redacted independently per merchant).
//   7. Write AuditLog evidence.
//
// All steps 2-7 run in one tx so a crash doesn't leave PII partially redacted.
//
// Idempotency (under sentinel substitution): a duplicate redact webhook
// looks up `(merchantId, originalGid)`. Step 3 replaced that GID with a
// sentinel, so findUnique returns null and the handler hits the
// `no_local_record` audit path — correct behavior (the customer IS already
// redacted). To distinguish "duplicate-after-redact" from
// "never-ingested" in the audit stream, the `no_local_record` audit's
// `context.shopifyCustomerGid` records the queried original GID; an
// operator can cross-reference a prior `customer_redact` audit for the
// same GID to identify duplicates.
//
// SOFT-DELETE EXTENSION INTERACTION: Customer is in SOFT_DELETE_MODELS, so
// the Prisma extension auto-filters reads on `deletedAt: null`. A Customer
// previously soft-deleted by another code path (e.g. Shopify 404 enrichment
// sweep, deletion via Shopify Admin UI) is invisible to step 1's findUnique
// and the redact hits `no_local_record`. That's a pre-existing gap, not
// introduced by B2; tracked in POINTS-TO-CONSIDER for M10 follow-up.
// ---------------------------------------------------------------------------

/**
 * Sentinel prefix for the redacted Customer.shopifyCustomerId column.
 *
 * Under GDPR erasure (B2), the original Shopify GID would re-link a
 * redacted Customer row back to a named person via Shopify-side data. The
 * column is NOT NULL + part of a composite unique index, so we can't null
 * it without a schema migration. The sentinel `redacted:<customer.id>`
 * preserves both constraints (customer.id is a globally-unique cuid →
 * sentinel is globally unique → no collision with live customers or with
 * other redacted customers), is deterministic (the same row redacted
 * twice produces the same sentinel), and is un-attributable from the GID
 * alone (the original GID is gone; the linkage exists only in the
 * AuditLog row's `context.shopifyCustomerGid` field, retained as
 * GDPR-required compliance evidence).
 *
 * Convention: any code that needs to identify a redacted row by column
 * shape MUST check this prefix, not parse a string literal. System-scope
 * queries that read past the Prisma soft-delete auto-filter (e.g.
 * forensic operator tooling, future GDPR audits) can use it to recognise
 * tombstoned rows.
 */
export const REDACTED_GID_SENTINEL_PREFIX = 'redacted:';

export interface ProcessCustomerRedactArgs {
  readonly prisma: WinbackPrisma;
  readonly merchantId: string;
  readonly shop: string;
  readonly payload: CustomerRedactPayload;
}

/**
 * Customer-CASCADE child tables that processCustomerRedact MUST hard-delete
 * to discharge GDPR Article 17 erasure for one customer (B2 / closes L3-H1).
 *
 * Three models declare `customer Customer @relation(onDelete: Cascade)` in
 * the schema: CustomerScore (per-customer RFM aggregates), AiGeneration
 * (systemPrompt + userPrompt + generatedText embed the customer's
 * firstName + behavioral data via packages/ai/src/prompt-builder.ts), and
 * Message (generatedText denormalised for Epic G dispatch). With Customer
 * soft-deleted, the schema CASCADE never fires and those rows survive with
 * PII intact — the L3-H1 leak. processCustomerRedact uses this list to
 * explicitly deleteMany inside the redact tx — table-level deletion, NOT
 * column-level scrub (B1's drift class applies to lists, not to columns;
 * row-level delete has nothing to drift on per added column).
 *
 * Order: child-most relations first to minimise per-step fan-out (Message
 * FKs to AiGeneration with CASCADE; same convention as
 * SHOP_REDACT_TABLES_IN_ORDER). CustomerScore has no inter-child FK; its
 * trailing position is mechanical, not correctness.
 *
 * Shape-tested in packages/db/tests/registry-shape.test.ts: every model
 * with `customer Customer @onDelete:Cascade` in the Prisma DMMF MUST appear
 * here. Epic G additions (e.g. CampaignTarget if it FKs to Customer with
 * CASCADE) trip the shape test on the next CI run and surface the drift
 * before they ship.
 *
 * Phase 2a — declared and shape-tested, NOT yet wired into
 * processCustomerRedact. Phase 2b wires the deleteMany loop after the
 * 3-table set is operator-confirmed complete against the live schema.
 */
export const CUSTOMER_REDACT_CHILD_TABLES = [
  'message',          // FK to AiGeneration + Customer + Merchant
  'aiGeneration',     // FK to Customer + Merchant
  'customerScore',    // FK to Customer + Merchant
] as const;

export async function processCustomerRedact(args: ProcessCustomerRedactArgs): Promise<void> {
  const { prisma, merchantId, shop, payload } = args;
  const auditLog = new AuditLogRepository(prisma);

  const numericId = payload.customer?.id;
  if (numericId == null || !/^\d+$/.test(String(numericId))) {
    // Malformed payload. Log via audit + return — Shopify retry won't fix
    // the payload, so we ack the work without acting on it. No business
    // action accompanies this audit row, so no tx is passed.
    await withTenantScope(merchantId, async () => {
      await auditLog.append({
        merchantId,
        shop,
        actorType: 'system',
        actorId: 'gdpr.processor',
        action: AUDIT_ACTIONS.gdpr.customer_redact_malformed,
        targetType: 'customer',
        ...(numericId != null && { targetId: String(numericId) }),
        context: { shopDomain: payload.shop_domain ?? null },
      });
    });
    return;
  }

  const shopifyCustomerGid = `gid://shopify/Customer/${String(numericId)}`;
  const uow = new UnitOfWork(prisma);

  await withTenantScope(merchantId, async () => {
    await uow.run(async (ctx) => {
      // 1. Locate the customer row. Skip-with-audit if absent — Shopify can
      // re-send redacts for customers we never ingested. Also covers
      // duplicate-delivery-after-redact: the row's shopifyCustomerId is
      // now a sentinel (step 3), so the lookup by original GID misses,
      // and we audit-and-no-op. Pull deletedAt for the L4-M3 conditional
      // set in step 4.
      const customer = await ctx.db.customer.findUnique({
        where: { merchantId_shopifyCustomerId: { merchantId, shopifyCustomerId: shopifyCustomerGid } },
        select: { id: true, deletedAt: true },
      });

      if (customer === null) {
        await auditLog.append(
          {
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
            },
          },
          ctx.db,
        );
        return;
      }

      // 2 + 3 + 4. NULL PII; replace shopifyCustomerId with the
      // un-attributable sentinel (preserves NOT NULL + composite-unique
      // while removing the original GID from the row); set deletedAt
      // ONLY if currently null (L4-M3: docstring promises the original
      // redact moment is preserved across duplicate deliveries — this
      // matches that promise; under sentinel substitution a duplicate
      // delivery hits the no_local_record path above anyway, but the
      // conditional is the structural guarantee, not the GID-rewrite).
      const sentinelShopifyCustomerId = `${REDACTED_GID_SENTINEL_PREFIX}${customer.id}`;
      await ctx.db.customer.update({
        where: { id: customer.id },
        data: {
          email: null,
          phone: null,
          firstName: null,
          lastName: null,
          shopifyCustomerId: sentinelShopifyCustomerId,
          ...(customer.deletedAt === null && { deletedAt: new Date() }),
        },
      });

      // 5. Sever Order link. Order.customerId becomes null; aggregate
      // revenue history preserved without identifier. Scoped by both
      // merchantId AND customerId — the merchantId scope is the
      // cross-tenant-bleed guard (same Shopify customer at two merchants
      // is two distinct Customer.id values; this filter only touches the
      // active tenant's Orders).
      await ctx.db.order.updateMany({
        where: { merchantId, customerId: customer.id },
        data: { customerId: null },
      });

      // 6. Hard-delete Customer-CASCADE children (Message, AiGeneration,
      // CustomerScore). Row-level delete removes the PII embedded in AI
      // text columns — nothing to drift on per new PII column. Driven
      // off CUSTOMER_REDACT_CHILD_TABLES so the impl can't diverge from
      // the registry-shape-tested set (B1's pattern, table-level not
      // column-level). Iterated in FK-safe child-first order (Message
      // FKs to AiGeneration with CASCADE; CustomerScore has no inter-
      // child FK so trailing position is mechanical).
      //
      // EACH deleteMany scoped { merchantId, customerId } — the
      // merchantId scope is the cross-tenant-bleed guard. Without it, a
      // crafted payload could in theory target a different merchant's
      // customer; with it, the filter is bounded to the active tenant's
      // FK graph regardless of input.
      interface CustomerRedactDelegate {
        deleteMany: (a: unknown) => Promise<unknown>;
      }
      type CustomerRedactDelegates = Record<(typeof CUSTOMER_REDACT_CHILD_TABLES)[number], CustomerRedactDelegate>;
      const childDelegates = ctx.db as unknown as CustomerRedactDelegates;
      for (const table of CUSTOMER_REDACT_CHILD_TABLES) {
        await childDelegates[table].deleteMany({
          where: { merchantId, customerId: customer.id },
        });
      }

      // 7. Audit evidence — same tx as steps 2-6.
      await auditLog.append(
        {
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
          },
        },
        ctx.db,
      );
    });
  });
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
// Exported so the registry-shape test can compare set-completeness against
// the schema (B1). Ordering is operational, not correctness — see comment
// block above; the test asserts SET equality, never positions.
//
// Insertion principle (per source comment above, "child-most relations
// first to minimize the cascade fan-out"):
//   - message, aiGeneration, customerScore → BEFORE customer (FK to Customer)
//   - message → BEFORE aiGeneration (FK to AiGeneration)
//   - aiSpendBucket → standalone (FK only to Merchant)
// B1 additions 2026-06-05 (audit L3-H2): closes the GDPR shop-redact PII
// survival risk for Epic E session 2 + Epic F batch 1 tables.
export const SHOP_REDACT_TABLES_IN_ORDER = [
  'orderLineItem',
  'order',
  'message',         // B1 — FK to AiGeneration + Customer + Merchant
  'aiGeneration',    // B1 — FK to Customer + Merchant
  'customerScore',   // B1 — FK to Customer + Merchant
  'productVariant',
  'product',
  'customer',
  'outboxEvent',
  'idempotencyKey',
  'backfillJob',
  'aiSpendBucket',   // B1 — FK to Merchant only
  'merchantSettings',
  'billingSubscription',
] as const;

type ShopRedactTable = (typeof SHOP_REDACT_TABLES_IN_ORDER)[number];

export async function processShopRedact(args: ProcessShopRedactArgs): Promise<void> {
  const { prisma, shop, payload } = args;
  const batchSize = args.batchSize ?? DEFAULT_SHOP_REDACT_BATCH_SIZE;
  const merchantRepo = new MerchantRepository(prisma);
  const auditLog = new AuditLogRepository(prisma);

  // 1. System-scope lookup. Idempotent if already redacted.
  const merchant = await withSystemScope(SYSTEM_SCOPE_REASONS.gdpr.shop_redact, async () => {
    return await merchantRepo.findByShop(shop);
  });

  if (merchant === null) {
    // Tombstone row: merchantId=null is legal here because we're in
    // system scope — the extension passes it through unmodified.
    await withSystemScope(SYSTEM_SCOPE_REASONS.gdpr.shop_redact, async () => {
      await auditLog.append({
        merchantId: null,
        shop,
        actorType: 'system',
        actorId: 'gdpr.processor',
        action: AUDIT_ACTIONS.gdpr.shop_redact_idempotent,
        targetType: 'merchant',
        context: { shopDomain: payload.shop_domain ?? null },
      });
    });
    return;
  }

  const merchantId = merchant.id;

  // 2. AuditLog FIRST inside tenant scope (FK SetNull preserves it).
  await withTenantScope(merchantId, async () => {
    await new UnitOfWork(prisma).run(async (ctx) => {
      await auditLog.append(
        {
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
          },
        },
        ctx.db,
      );
    });
  });

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
    await merchantRepo.hardDelete(merchantId);
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
  interface TenantDelegate {
    findMany: (a: unknown) => Promise<{ id: string }[]>;
    deleteMany: (a: unknown) => Promise<unknown>;
  }
  type TenantDelegates = Record<ShopRedactTable, TenantDelegate>;

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
