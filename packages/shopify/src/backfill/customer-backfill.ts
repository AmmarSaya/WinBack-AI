import type { Prisma } from '@prisma/client';

import type { AdminClient } from '../admin/client.js';
import type { PageFetcher, PageProcessor, ResourcePage } from './types.js';

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

/**
 * Page processor: upserts each customer USING THE PASSED `tx` so the
 * writes participate in the same transaction as the cursor commit. We
 * cannot route through `CustomerRepository.upsertFromShopify` here
 * because that method holds its own prisma reference (constructor-bound)
 * and would write outside the tx.
 *
 * Tenant safety here is bounded by the runner: BackfillRunner.run calls
 * this only after `withTenantScope(merchantId)`, and the `tx` itself
 * came from `UnitOfWork.run` which asserts tenant scope at entry.
 */
export class CustomerPageProcessor implements PageProcessor<ShopifyCustomerNode> {
  async processItems(args: {
    tx: Prisma.TransactionClient;
    merchantId: string;
    items: readonly ShopifyCustomerNode[];
  }): Promise<void> {
    for (const node of args.items) {
      const shopifyCustomerId = parseGid(node.id);
      const data = {
        merchantId: args.merchantId,
        shopifyCustomerId,
        email: node.email,
        phone: node.phone,
        firstName: node.firstName,
        lastName: node.lastName,
        acceptsMarketing: node.emailMarketingConsent?.marketingState === 'SUBSCRIBED',
        acceptsSms: node.smsMarketingConsent?.marketingState === 'SUBSCRIBED',
        ordersCount: parseIntOrZero(node.numberOfOrders),
        tags: node.tags ?? [],
        shopifyCreatedAt: parseDateOrNull(node.createdAt),
        shopifyUpdatedAt: parseDateOrNull(node.updatedAt),
      };
      await args.tx.customer.upsert({
        where: {
          merchantId_shopifyCustomerId: {
            merchantId: args.merchantId,
            shopifyCustomerId,
          },
        },
        create: data,
        update: {
          email: data.email,
          phone: data.phone,
          firstName: data.firstName,
          lastName: data.lastName,
          acceptsMarketing: data.acceptsMarketing,
          acceptsSms: data.acceptsSms,
          ordersCount: data.ordersCount,
          tags: data.tags,
          shopifyUpdatedAt: data.shopifyUpdatedAt,
        },
      });
    }
  }
}

/**
 * Extracts the numeric id from a Shopify GID. Returns the input unchanged
 * if it doesn't match the GID format (defensive — never throw on a
 * malformed id; let the upsert see whatever Shopify returned).
 */
export function parseGid(gid: string): string {
  const last = gid.split('/').pop();
  return last !== undefined && last.length > 0 ? last : gid;
}

function parseIntOrZero(v: string | null): number {
  if (v === null) return 0;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function parseDateOrNull(v: string | null): Date | null {
  if (v === null) return null;
  const d = new Date(v);
  return Number.isFinite(d.valueOf()) ? d : null;
}
