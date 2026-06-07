import { type Customer, Prisma } from '@prisma/client';
import { ValidationError } from '@winback/errors';

import { toShopifyCustomerGid } from '../gid.js';
import { assertScopeMatchesMerchant } from '../tenant-scope.js';
import type { ShopifyCustomerWebhookBody } from '../webhook-bodies.js';

import { BaseRepository } from './base.js';

/**
 * Customer repository — typed write chokepoint for the Customer table.
 *
 * `findByEmail` uses raw SQL via `BaseRepository.queryRawScoped` to
 * leverage the B2 T1 functional index (`customer_merchant_email_lower`).
 * The base helper asserts tenant scope BEFORE executing — raw SQL
 * bypasses the Prisma extension, so we assert manually.
 *
 * `upsertFromWebhook` is the entry point for the drainer's
 * `customers/create` and `customers/update` handlers. Per EPIC-E-FIELD-
 * MAPPING.md row C9: this method does NOT write `Customer.state` —
 * Shopify's `customer.state` (account-lifecycle:
 * `enabled`/`disabled`/`invited`/`declined`) is semantically distinct
 * from our `Customer.state` (RFM-lifecycle:
 * `active`/`warm`/`at_risk`/`dormant`/`lost`). Session 2's scoring
 * writer is the only thing that mutates our column.
 *
 * `softDelete` handles the non-GDPR `customers/delete` topic. GDPR
 * deletion is handled separately by `processCustomerRedact` in
 * `../compliance/gdpr-processor.ts`.
 *
 * History: pre-Epic-E session 1 this class had an `upsertFromShopify`
 * method that took pre-extracted input fields and used `this.prisma`
 * (no tx). It was dead code (zero callers in production or tests). Epic
 * E session 1 deleted it and added the webhook-body-aware
 * `upsertFromWebhook` with required `tx`.
 */
export class CustomerRepository extends BaseRepository {
  /**
   * Case-insensitive email lookup, scoped to a single merchant. Uses
   * the T1 functional + partial index. Returns the first match
   * (typically unique by merchant + email; the constraint isn't
   * enforced at DB level since email is nullable and Shopify allows
   * duplicates in rare data-import scenarios).
   */
  async findByEmail(merchantId: string, email: string): Promise<Customer | null> {
    const rows = await this.queryRawScoped<Customer>(
      merchantId,
      Prisma.sql`
        SELECT *
        FROM "Customer"
        WHERE "merchantId" = ${merchantId}
          AND lower(email) = lower(${email})
          AND "deletedAt" IS NULL
        LIMIT 1
      `,
    );
    return rows[0] ?? null;
  }

  /**
   * Direct Shopify-ID lookup. Uses the composite unique index
   * (merchantId, shopifyCustomerId). Soft-delete filter applied by the
   * Prisma extension automatically.
   */
  async findByShopifyId(
    merchantId: string,
    shopifyCustomerId: string,
  ): Promise<Customer | null> {
    return this.prisma.customer.findUnique({
      where: { merchantId_shopifyCustomerId: { merchantId, shopifyCustomerId } },
    });
  }

  /**
   * Upsert a Customer from a Shopify customers/create or customers/update
   * webhook body. Idempotent on `(merchantId, shopifyCustomerId)`.
   *
   * Per EPIC-E-FIELD-MAPPING.md:
   *   - C18: tags split per P-6 (comma-separated string → trimmed array).
   *   - C21/C22/C23: acceptsMarketing / acceptsSms derived from
   *     `email_marketing_consent.state === 'subscribed'` /
   *     `sms_marketing_consent.state === 'subscribed'`. Unknown states
   *     fall through to `false` correctly (Shopify has historically
   *     added enum values without notice).
   *   - C9: Shopify's `state` field NOT consumed. Our `Customer.state`
   *     is the RFM-lifecycle enum, semantically distinct, written only
   *     by session 2's scoring writer.
   *   - C10: `total_spent` excluded (Shopify cross-currency aggregate;
   *     meaningless multi-currency).
   *
   * `tx` is REQUIRED (not optional) — see OrderRepository for the same
   * rationale.
   */
  async upsertFromWebhook(args: UpsertCustomerFromWebhookArgs): Promise<UpsertCustomerFromWebhookResult> {
    const { merchantId, body, tx } = args;
    assertScopeMatchesMerchant(merchantId);

    const shopifyCustomerId = toShopifyCustomerGid(body.id);
    if (shopifyCustomerId === null) {
      throw new ValidationError(`Customer webhook body.id is not a valid numeric id`, {
        code: 'customer.invalid_id',
        fields: { received: String(body.id) },
      });
    }

    // Derived consent flags. `?? undefined` → schema default `false`
    // applies on create. On update, only override when the consent
    // object is present (don't clobber existing flags with `false` on
    // a webhook that doesn't carry consent state).
    const acceptsMarketing =
      body.email_marketing_consent?.state === 'subscribed' ? true : undefined;
    const acceptsSms =
      body.sms_marketing_consent?.state === 'subscribed' ? true : undefined;

    // Tags split per P-6. `null` / `undefined` → empty array.
    const tags = splitTags(body.tags ?? null);

    // isNewCustomer determined from a pre-write findUnique inside the same tx
    // (same TX INVARIANT as OrderRepository — the read must use args.tx).
    const existing = await tx.customer.findUnique({
      where: { merchantId_shopifyCustomerId: { merchantId, shopifyCustomerId } },
      select: { id: true },
    });

    const sharedFields = {
      email: body.email ?? null,
      phone: body.phone ?? null,
      firstName: body.first_name ?? null,
      lastName: body.last_name ?? null,
      ...(acceptsMarketing !== undefined && { acceptsMarketing }),
      ...(acceptsSms !== undefined && { acceptsSms }),
      ...(body.orders_count !== null && body.orders_count !== undefined
        ? { ordersCount: body.orders_count }
        : {}),
      tags,
      shopifyCreatedAt: new Date(body.created_at),
      shopifyUpdatedAt: new Date(body.updated_at),
    };

    const upserted = await tx.customer.upsert({
      where: { merchantId_shopifyCustomerId: { merchantId, shopifyCustomerId } },
      create: {
        merchantId,
        shopifyCustomerId,
        ...sharedFields,
      },
      update: sharedFields,
      select: { id: true },
    });

    return {
      customerId: upserted.id,
      isNewCustomer: existing === null,
    };
  }

  /**
   * Soft-delete a Customer in response to a non-GDPR `customers/delete`
   * webhook. Sets `deletedAt = now()` if the row exists and isn't
   * already deleted; idempotent on already-deleted (returns `existed:
   * false` for consistency with `MerchantRepository.markUninstalled`'s
   * guard pattern).
   *
   * GDPR deletion (customers/redact) is a separate flow handled by
   * `processCustomerRedact` in `../compliance/gdpr-processor.ts`.
   *
   * `tx` is REQUIRED (same rationale as upsertFromWebhook).
   */
  async softDelete(args: SoftDeleteCustomerArgs): Promise<SoftDeleteCustomerResult> {
    const { merchantId, shopifyCustomerId, tx } = args;
    assertScopeMatchesMerchant(merchantId);

    const result = await tx.customer.updateMany({
      where: {
        merchantId,
        shopifyCustomerId,
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });

    return { existed: result.count > 0 };
  }
}

export interface UpsertCustomerFromWebhookArgs {
  readonly merchantId: string;
  readonly body: ShopifyCustomerWebhookBody;
  readonly tx: Prisma.TransactionClient;
}

export interface UpsertCustomerFromWebhookResult {
  readonly customerId: string;
  readonly isNewCustomer: boolean;
}

export interface SoftDeleteCustomerArgs {
  readonly merchantId: string;
  /** Already-wrapped GID (e.g. "gid://shopify/Customer/12345"). */
  readonly shopifyCustomerId: string;
  readonly tx: Prisma.TransactionClient;
}

export interface SoftDeleteCustomerResult {
  /**
   * `true` if a row was updated (existed + wasn't already deleted).
   * `false` on already-deleted OR non-existent (idempotent on either).
   */
  readonly existed: boolean;
}

// ---------------------------------------------------------------------------
// File-private helpers
// ---------------------------------------------------------------------------

/**
 * Split a Shopify comma-separated tags string into a trimmed array.
 * Empty strings after split are dropped. Per P-6 in
 * EPIC-E-FIELD-MAPPING.md.
 *
 * Examples:
 *   "vip, repeat-buyer, loyal" → ["vip", "repeat-buyer", "loyal"]
 *   ""                         → []
 *   null                       → []
 *   "  vip  ,  ,  loyal  "    → ["vip", "loyal"]
 */
function splitTags(tags: string | null): string[] {
  if (tags === null) return [];
  return tags
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
