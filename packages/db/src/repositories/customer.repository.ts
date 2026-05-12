import { type Customer, Prisma } from '@prisma/client';

import { assertScopeMatchesMerchant } from '../tenant-scope.js';
import { BaseRepository } from './base.js';

/**
 * Customer repository.
 *
 * `findByEmail` uses raw SQL via the `BaseRepository.queryRawScoped` helper
 * to leverage the B2 T1 functional index (`customer_merchant_email_lower`,
 * composite + functional + partial). The base helper asserts tenant scope
 * BEFORE executing — raw SQL bypasses the Prisma extension, so we must
 * assert manually. See `BaseRepository` JSDoc for the convention.
 *
 * The `deletedAt IS NULL` predicate in the SQL matches the soft-delete
 * extension's auto-filter so behavior is identical to a Prisma-typed read.
 *
 * Future C5 (backfill) and E (intelligence) will add more methods.
 */
export class CustomerRepository extends BaseRepository {
  /**
   * Case-insensitive email lookup, scoped to a single merchant. Uses the
   * T1 functional + partial index. Returns the first match (typically
   * unique by merchant + email but the constraint isn't enforced at DB
   * level since email is nullable and Shopify allows duplicates in rare
   * data-import scenarios).
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
   * Idempotent sync from a Shopify customers/* webhook payload.
   *
   * `merchantId` is accepted explicitly because Prisma's composite-unique
   * `where` shape (`merchantId_shopifyCustomerId`) requires both fields
   * present in the type and cannot be filled in by the extension's where-
   * injection (which targets `where.merchantId` directly, not a nested
   * composite key object). `assertScopeMatchesMerchant` enforces that the
   * caller can't claim a merchantId different from the active scope.
   *
   * Returns the row id so subsequent operations (outbox publish, etc.) can
   * reference it without an extra read.
   *
   * NOTE: this is a thin upsert wrapper used by webhook handlers. The
   * full sync semantics (state transitions, score recomputation,
   * `customer.updated@v1` outbox publishing) live in the customer-sync
   * service (added in C5 / E3).
   */
  async upsertFromShopify(
    merchantId: string,
    input: {
      shopifyCustomerId: string;
      email?: string | null;
      phone?: string | null;
      firstName?: string | null;
      lastName?: string | null;
      acceptsMarketing?: boolean;
      acceptsSms?: boolean;
      ordersCount?: number;
      firstOrderAt?: Date | null;
      lastOrderAt?: Date | null;
      tags?: string[];
      shopifyCreatedAt?: Date | null;
      shopifyUpdatedAt?: Date | null;
    },
  ): Promise<{ id: string }> {
    assertScopeMatchesMerchant(merchantId);

    const createData: Prisma.CustomerUncheckedCreateInput = {
      merchantId,
      shopifyCustomerId: input.shopifyCustomerId,
      ...(input.email !== undefined && { email: input.email }),
      ...(input.phone !== undefined && { phone: input.phone }),
      ...(input.firstName !== undefined && { firstName: input.firstName }),
      ...(input.lastName !== undefined && { lastName: input.lastName }),
      ...(input.acceptsMarketing !== undefined && { acceptsMarketing: input.acceptsMarketing }),
      ...(input.acceptsSms !== undefined && { acceptsSms: input.acceptsSms }),
      ...(input.ordersCount !== undefined && { ordersCount: input.ordersCount }),
      ...(input.firstOrderAt !== undefined && { firstOrderAt: input.firstOrderAt }),
      ...(input.lastOrderAt !== undefined && { lastOrderAt: input.lastOrderAt }),
      ...(input.tags !== undefined && { tags: input.tags }),
      ...(input.shopifyCreatedAt !== undefined && { shopifyCreatedAt: input.shopifyCreatedAt }),
      ...(input.shopifyUpdatedAt !== undefined && { shopifyUpdatedAt: input.shopifyUpdatedAt }),
    };

    const result = await this.prisma.customer.upsert({
      where: {
        merchantId_shopifyCustomerId: {
          merchantId,
          shopifyCustomerId: input.shopifyCustomerId,
        },
      },
      create: createData,
      update: {
        ...(input.email !== undefined && { email: input.email }),
        ...(input.phone !== undefined && { phone: input.phone }),
        ...(input.firstName !== undefined && { firstName: input.firstName }),
        ...(input.lastName !== undefined && { lastName: input.lastName }),
        ...(input.acceptsMarketing !== undefined && {
          acceptsMarketing: input.acceptsMarketing,
        }),
        ...(input.acceptsSms !== undefined && { acceptsSms: input.acceptsSms }),
        ...(input.ordersCount !== undefined && { ordersCount: input.ordersCount }),
        ...(input.firstOrderAt !== undefined && { firstOrderAt: input.firstOrderAt }),
        ...(input.lastOrderAt !== undefined && { lastOrderAt: input.lastOrderAt }),
        ...(input.tags !== undefined && { tags: input.tags }),
        ...(input.shopifyUpdatedAt !== undefined && {
          shopifyUpdatedAt: input.shopifyUpdatedAt,
        }),
      },
      select: { id: true },
    });
    return result;
  }
}
