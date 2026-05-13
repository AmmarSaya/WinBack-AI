import type { Prisma } from '@prisma/client';

import type { WinbackPrisma } from '../client.js';

/**
 * Repository for the Merchant table — the typed write chokepoint for all
 * Merchant CRUD.
 *
 * Why it exists. Prior to step 4, three independent files wrote directly
 * to `prisma.merchant.*`:
 *   - shopify/install.ts (completeInstall — install upsert)
 *   - shopify/backfill/install-enrichment.ts (post-install enrichment)
 *   - db/compliance/gdpr-processor.ts (GDPR shop_redact: find + delete)
 *
 * Each had its own conventions for tenant scope, audit, and field
 * selection. Consolidating them here means a fourth or fifth caller
 * (token-revocation flows in D2, operator interventions, etc.) inherits
 * the same shape rather than re-deriving it.
 *
 * Scope semantics. `Merchant` is the tenant ROOT — it isn't in any of the
 * three classification sets in `tenant-scope.ts` (TENANT_SCOPED,
 * TENANT_OPTIONAL_READ, UNSCOPED). The Prisma extension has an explicit
 * `if (model === 'Merchant')` branch (`hooks.ts` lines 91–107 + 145–156):
 *
 *   - In tenant scope: every read/write must target the active merchant id.
 *     `upsertInstall` would therefore NOT work in tenant scope (it's a
 *     row-creating op for a tenant that doesn't yet exist) — but
 *     `upsertInstall` is only called from system scope. The extension
 *     handles that case via pass-through.
 *   - In system scope: pass-through. The repository is itself scope-
 *     agnostic; the extension does the right thing in each case.
 *
 * Callers therefore do NOT need to know whether they're in tenant or
 * system scope to use this repository. They just need to be in SOME
 * scope (the extension throws on writes with no active scope at all).
 *
 * Transaction handling. Every method accepts an optional `tx` parameter
 * (a `Prisma.TransactionClient`). When the caller is inside
 * `prisma.$transaction(...)` or `UnitOfWork.run(ctx => ...)` they pass
 * their transaction client and the operation joins the surrounding
 * transaction. Otherwise the operation runs against `this.prisma`
 * directly. Same pattern as `BackfillJobRepository`.
 */
export class MerchantRepository {
  constructor(private readonly prisma: WinbackPrisma) {}

  /**
   * Find a merchant by shop domain. Returns null if not installed.
   *
   * Used by:
   *   - `completeInstall`, as the "is this a reinstall?" pre-check.
   *   - `gdpr-processor.processShopRedact`, as the idempotency probe.
   *
   * Works from any scope. In tenant scope the extension's Merchant branch
   * doesn't constrain a `findUnique by shop` directly — the shop column
   * isn't the tenant id — but the install/gdpr call sites always run in
   * system scope, where the branch is a pass-through.
   */
  async findByShop(
    shop: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string } | null> {
    const client = tx ?? this.prisma;
    return client.merchant.findUnique({
      where: { shop },
      select: { id: true },
    });
  }

  /**
   * Atomically upsert the Merchant row for an install/reinstall flow.
   *
   *   - New install: creates the row with `installedAt: now()`.
   *   - Re-install:  clears `tokenRevokedAt` + `uninstalledAt` so the
   *                  health check stops paging.
   *
   * Returns `{ id, isNewInstall }`. The flag is derived from a
   * `findUnique` performed before the `upsert`, both inside the caller's
   * transaction.
   *
   * KNOWN RACE — `isNewInstall` is NOT strictly correct under concurrent
   * installs for the same shop. With Postgres's default READ COMMITTED
   * isolation, two simultaneous transactions A and B can both see
   * `null` on the pre-check (because neither has committed yet) before
   * the upsert resolves the actual write. Postgres `INSERT ... ON
   * CONFLICT DO UPDATE` then has one transaction create the row and the
   * other update it — but BOTH report `isNewInstall: true` because both
   * observed `null` at SELECT time. The race window is on the order of
   * tens of milliseconds at most.
   *
   *   Practical mitigation today: Shopify OAuth `code` values are
   *   single-use, so two concurrent install callbacks for the same shop
   *   carry the same code; only the first succeeds at the upstream token
   *   exchange. The second callback never reaches `completeInstall`.
   *   This is a real-world defense, not a correctness guarantee.
   *
   *   Consequence if the race fires anyway: the `merchant.installed`
   *   outbox event payload carries `reinstall: false` when it should be
   *   `true`. D2 consumers must remain idempotent against duplicate
   *   first-install signals (BackfillJob's `@@unique(merchantId, resource)`
   *   already provides this at the database layer).
   *
   *   Hardening paths (deferred to M10 or whenever this matters): either
   *   SERIALIZABLE isolation on the install transaction with retry, a
   *   Postgres advisory lock keyed on shop, or dropping `isNewInstall`
   *   from the API and emitting the same event regardless. See gap
   *   register entry for follow-up.
   *
   * MUST be called from system scope. `completeInstall` is the canonical
   * caller and opens `withSystemScope('shopify.install')` because no
   * tenant exists yet at install time.
   */
  async upsertInstall(
    args: UpsertInstallArgs,
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string; isNewInstall: boolean }> {
    const client = tx ?? this.prisma;
    const existing = await client.merchant.findUnique({
      where: { shop: args.shop },
      select: { id: true },
    });
    const isNewInstall = existing === null;

    const merchant = await client.merchant.upsert({
      where: { shop: args.shop },
      create: { shop: args.shop, installedAt: new Date() },
      update: { tokenRevokedAt: null, uninstalledAt: null },
      select: { id: true },
    });

    return { id: merchant.id, isNewInstall };
  }

  /**
   * Persist enrichment fields fetched from Shopify's Shop query
   * (email / name / country / currency / timezone / shopifyPlan) plus
   * the `shopDetailsFetchedAt` timestamp.
   *
   * Field updates and timestamp are emitted as a single SQL UPDATE; if
   * the caller's transaction rolls back, `shopDetailsFetchedAt` stays
   * null and the health check correctly continues to flag this merchant
   * as un-enriched.
   *
   * Works from tenant scope (`enrichInstall` runs inside `withTenantScope
   * (merchantId)` + `UnitOfWork.run`); the extension's Merchant branch
   * asserts the target id matches the active tenant. Also works from
   * system scope if a future caller needs it (operator dashboards).
   */
  async updateEnrichment(
    merchantId: string,
    args: UpdateEnrichmentArgs,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    await client.merchant.update({
      where: { id: merchantId },
      data: {
        email: args.email,
        name: args.name,
        country: args.country,
        currency: args.currency,
        timezone: args.timezone,
        shopifyPlan: args.shopifyPlan,
        shopDetailsFetchedAt: new Date(),
      },
    });
  }

  /**
   * Permanently delete a Merchant row. CASCADE removes any remaining
   * tenant-scoped children; SetNull preserves AuditLog + WebhookLog for
   * forensic / compliance retention.
   *
   * MUST be called from system scope. The only legitimate caller today
   * is `gdpr-processor.processShopRedact` after it has audit-logged the
   * action and chunked-deleted the tenant tables. Calling `hardDelete`
   * from tenant scope is a contradiction (deleting the row that defines
   * the active scope) and the extension's Merchant branch in tenant
   * scope would assert that `where.id === scope.merchantId` — which is
   * structurally allowed, but semantically a footgun. Document via
   * caller comments where appropriate.
   */
  async hardDelete(
    merchantId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    await client.merchant.delete({ where: { id: merchantId } });
  }
}

export interface UpsertInstallArgs {
  readonly shop: string;
}

export interface UpdateEnrichmentArgs {
  readonly email: string | null;
  readonly name: string | null;
  readonly country: string | null;
  readonly currency: string | null;
  readonly timezone: string | null;
  readonly shopifyPlan: string | null;
}
