import { BACKFILL_RESOURCES, type BackfillResource } from '@winback/contracts';
import { getLogger } from '@winback/logger';
import type { Prisma } from '@prisma/client';

import type { AdminClient } from '../admin/client.js';
import type { PageFetcher, PageProcessor, ResourcePage } from './types.js';

const log = getLogger('shopify.backfill.customer');

/** Resource identifier for this fetcher/processor pair. */
export const CUSTOMER_BACKFILL_RESOURCE: BackfillResource = BACKFILL_RESOURCES.customers;

/**
 * Shape parsed out of Shopify's GraphQL customers connection. Only the
 * fields we persist are extracted; full payload is omitted for cost.
 */
export interface ShopifyCustomerNode {
  readonly id: string; // gid://shopify/Customer/<numeric>
  readonly email: string | null;
  readonly phone: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly emailMarketingConsent: { marketingState: string } | null;
  readonly smsMarketingConsent: { marketingState: string } | null;
  readonly numberOfOrders: string | null; // Shopify returns as string
  readonly tags: string[] | null;
  readonly createdAt: string | null; // ISO-8601
  readonly updatedAt: string | null;
}

interface RawCustomersResponse {
  customers?: {
    pageInfo: { endCursor: string | null; hasNextPage: boolean };
    nodes: ShopifyCustomerNode[];
  };
}

const CUSTOMERS_PAGE_QUERY = /* GraphQL */ `
  query CustomersPage($first: Int!, $after: String) {
    customers(first: $first, after: $after, sortKey: ID) {
      pageInfo { endCursor hasNextPage }
      nodes {
        id
        email
        phone
        firstName
        lastName
        emailMarketingConsent { marketingState }
        smsMarketingConsent { marketingState }
        numberOfOrders
        tags
        createdAt
        updatedAt
      }
    }
  }
`;

/**
 * Page fetcher for the `customers/` backfill. Every call goes through
 * `AdminClient.graphql` — which is gated by `CostTracker` — so the C5
 * guardrail "every page is rate-limit-gated" is structurally enforced.
 */
export class CustomerPageFetcher implements PageFetcher<ShopifyCustomerNode> {
  constructor(private readonly client: AdminClient) {}

  async fetch(args: {
    merchantId: string;
    cursor: string | null;
    pageSize: number;
  }): Promise<ResourcePage<ShopifyCustomerNode>> {
    const data = await this.client.graphql<RawCustomersResponse>(args.merchantId, {
      query: CUSTOMERS_PAGE_QUERY,
      variables: { first: args.pageSize, after: args.cursor },
      // Customers query base cost ~3 + ~0.05 * pageSize (Shopify cost calc).
      // Conservative pre-flight hint:
      estimatedCost: Math.max(10, Math.ceil(args.pageSize / 5)),
    });
    const conn = data.customers;
    if (conn === undefined) {
      return { items: [], endCursor: null, hasNextPage: false };
    }
    return {
      items: conn.nodes,
      endCursor: conn.pageInfo.endCursor,
      hasNextPage: conn.pageInfo.hasNextPage,
    };
  }
}

// =============================================================================
// FIELD OWNERSHIP BOUNDARY (do not silently expand)
//
// The backfill upsert OWNS the Shopify-sourced fields below. The local
// app (Epic E intelligence, Epic G campaigns, audit/admin tooling, etc.)
// MUST NOT write to these — Shopify is the source of truth, our upserts
// from this file overwrite them on every webhook + backfill.
//
//   SHOPIFY-OWNED (this processor writes; backfill + webhook may overwrite):
//     - email, phone, firstName, lastName
//     - acceptsMarketing, acceptsSms
//     - ordersCount, tags
//     - shopifyCreatedAt (create-only), shopifyUpdatedAt
//
// The backfill DOES NOT touch these computed/local-owned fields. If you
// see them appear in the `update` block below in a future PR, that's a
// silent data-loss bug — reject the change:
//
//   COMPUTED / LOCAL-OWNED (never write from backfill):
//     - state           — computed by E1 intelligence engine
//     - isVip           — computed by E5 (VIP segmentation)
//     - firstOrderAt    — computed from Order table
//     - lastOrderAt     — computed from Order table
//     - deletedAt       — lifecycle managed by us (GDPR redact + sync)
//     - createdAt / updatedAt — DB-managed
//
// New Shopify fields → add to update block + this comment block. New
// computed fields → add to the second list. The boundary is explicit
// here so additions require a conscious decision, not a silent one.
// =============================================================================

const SHOPIFY_OWNED_FIELDS = [
  'email',
  'phone',
  'firstName',
  'lastName',
  'acceptsMarketing',
  'acceptsSms',
  'ordersCount',
  'tags',
  'shopifyUpdatedAt',
] as const satisfies ReadonlyArray<keyof Prisma.CustomerUncheckedCreateInput>;

/**
 * Page processor: upserts each customer USING THE PASSED `tx` so the
 * writes participate in the same transaction as the cursor commit. The
 * update block is constrained to SHOPIFY_OWNED_FIELDS above.
 *
 * Tenant safety here is bounded by the runner: BackfillRunner.run calls
 * this only after `withTenantScope(merchantId)`, and the `tx` itself
 * came from `UnitOfWork.run` which asserts tenant scope at entry.
 *
 * Storage format: `shopifyCustomerId` is the FULL GID
 * (e.g. "gid://shopify/Customer/12345"). See parseGid header comment for
 * the decision rationale and the coordination contract with the future
 * webhook drainer (D2).
 *
 * Malformed-GID handling: skipped + logged. A bad GID would otherwise be
 * silently stored as `shopifyCustomerId`, breaking later Admin API calls
 * that pass it as `ID!`.
 */
export class CustomerPageProcessor implements PageProcessor<ShopifyCustomerNode> {
  async processItems(args: {
    tx: Prisma.TransactionClient;
    merchantId: string;
    items: readonly ShopifyCustomerNode[];
  }): Promise<void> {
    for (const node of args.items) {
      const shopifyCustomerId = parseGid(node.id);
      if (shopifyCustomerId === null) {
        log.warn(
          { merchantId: args.merchantId, malformedGid: node.id },
          'backfill: skipping customer with malformed GID',
        );
        continue;
      }

      // Typed against CreateInput so raw values fit both `create` and
      // `update` blocks — UpdateInput's wrapper types (e.g.
      // NullableStringFieldUpdateOperationsInput) are a superset.
      const shopifyOwned: Pick<
        Prisma.CustomerUncheckedCreateInput,
        (typeof SHOPIFY_OWNED_FIELDS)[number]
      > = {
        email: node.email,
        phone: node.phone,
        firstName: node.firstName,
        lastName: node.lastName,
        acceptsMarketing: node.emailMarketingConsent?.marketingState === 'SUBSCRIBED',
        acceptsSms: node.smsMarketingConsent?.marketingState === 'SUBSCRIBED',
        ordersCount: parseIntOrZero(node.numberOfOrders),
        tags: node.tags ?? [],
        shopifyUpdatedAt: parseDateOrNull(node.updatedAt),
      };

      await args.tx.customer.upsert({
        where: {
          merchantId_shopifyCustomerId: {
            merchantId: args.merchantId,
            shopifyCustomerId,
          },
        },
        create: {
          merchantId: args.merchantId,
          shopifyCustomerId,
          shopifyCreatedAt: parseDateOrNull(node.createdAt),
          ...shopifyOwned,
        },
        // CRITICAL: only Shopify-owned fields. See SHOPIFY_OWNED_FIELDS above.
        // Never add state, isVip, firstOrderAt, lastOrderAt, deletedAt here.
        update: shopifyOwned,
      });
    }
  }
}

/**
 * Strict Shopify GID validator. Accepts only the canonical form
 *   gid://shopify/<Type>/<digits>
 * and returns the **full GID string** on success, `null` on malformed.
 *
 * STORAGE FORMAT DECISION (locked here, definitive):
 *
 *   `Customer.shopifyCustomerId` stores the FULL GID
 *   (e.g. "gid://shopify/Customer/12345"), NOT the numeric portion.
 *
 * Reasons:
 *   1. Schema header (B1 v2.2) declares "External Shopify IDs are String
 *      (forward-compat with GIDs)" — the intent is full-GID storage.
 *   2. Modern Shopify Admin GraphQL mutations take `ID!` (GIDs). Storing
 *      GIDs avoids reconstruction at every call site.
 *   3. The numeric portion is ambiguous across resources (12345 could be
 *      a Customer, Order, or Product). The full GID disambiguates.
 *
 * Coordination with the webhook drainer (Epic E session 1): webhook
 * payloads carry the numeric id (`body.id` → e.g. 12345). The drainer
 * MUST wrap before upsert: `toShopifyCustomerGid(body.id)` — see
 * `packages/shopify/src/gid.ts` for that helper and its four siblings
 * (`toShopifyOrderGid`, `toShopifyProductGid`, etc.). That single wrap
 * point is the cost of storing GIDs everywhere else.
 *
 * Callers are expected to skip + log malformed inputs rather than store
 * them — silent passthrough is how corruption spreads.
 */
const GID_PATTERN = /^gid:\/\/shopify\/[A-Za-z][A-Za-z0-9]*\/(\d+)$/;

export function parseGid(gid: string): string | null {
  return GID_PATTERN.test(gid) ? gid : null;
}

/**
 * Extracts the numeric portion from a validated GID. Rarely needed —
 * provided for the edge cases that interact with legacy REST endpoints
 * that take numeric IDs. Returns null on malformed input.
 */
export function extractNumericIdFromGid(gid: string): string | null {
  const match = GID_PATTERN.exec(gid);
  return match?.[1] ?? null;
}

export function parseIntOrZero(v: string | null): number {
  if (v === null) return 0;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parses an ISO-8601 string into a Date, returns null on null/garbage.
 *
 * NODE / V8 NOTE: this relies on `new Date('')` producing an Invalid Date
 * (valueOf → NaN), which is the V8/Node.js behavior but is technically
 * implementation-defined per the ECMAScript spec for unrecognized strings.
 * Safe in our Node-only server target. If this code ever runs in another
 * JS engine where `new Date('')` returns the Unix epoch (rare but spec-
 * permitted), the empty-string case would silently turn into 1970-01-01.
 * Add an explicit `if (v === '') return null` if that ever becomes a
 * possibility.
 */
export function parseDateOrNull(v: string | null): Date | null {
  if (v === null) return null;
  const d = new Date(v);
  return Number.isFinite(d.valueOf()) ? d : null;
}
