import type { AdminClient } from './client.js';

/**
 * Fetches the customer's most-recent paid (or partially-paid) orders'
 * primary line-item titles via the Shopify Admin GraphQL API.
 *
 * Used by Epic F's `handleCustomerStateChanged` drainer handler (§F-9
 * step 6b) to populate `WinbackPromptArgs.recentProducts` for
 * `buildWinbackPrompt`. The prompt builder cares only about product
 * titles — no price, no SKU, no variant — so this helper deliberately
 * returns the minimum shape that maps 1:1 to
 * `WinbackPromptArgs.recentProducts` (`readonly { title: string }[]`).
 *
 * Why Shopify Admin API (not local DB):
 * Per §F-9 step 6b the read is an external HTTP call. The
 * POST-EPIC-F-CONSCIOUS-DECISION.md Section 3 plan to refactor this
 * to a local-DB query against `Order` + `OrderLineItem` is acknowledged
 * future work, NOT a shortcut for batch 4. Honoring the design
 * contract here keeps batch 4's audit boundary clean; Section 3 will
 * swap this helper out for a Prisma query when its time comes.
 *
 * MUST be called OUTSIDE any `prisma.$transaction` (locked rule: no
 * external HTTP inside a Postgres tx — provider timeouts would hold
 * the tx open).
 *
 * Defensive returns:
 *   - `customer` is null (deleted between local upsert + this API call,
 *     or never existed on Shopify's side): `[]`
 *   - `customer.orders.edges` is empty (no paid orders yet): `[]`
 *   - A given order's `lineItems.edges` is empty (unusual but possible
 *     for refunded-only orders or partial backfill): skip that order
 *     (other orders' line items still return)
 *   - GraphQL throws (network error, 5xx, auth): caller handles. The
 *     handler swallows + uses `recentProducts: []` so a Shopify outage
 *     doesn't block winback message generation.
 */
export const RECENT_PAID_ORDERS_QUERY = `
  query RecentPaidOrders($customerId: ID!, $first: Int!) {
    customer(id: $customerId) {
      orders(
        first: $first
        sortKey: PROCESSED_AT
        reverse: true
        query: "financial_status:paid OR financial_status:partially_paid"
      ) {
        edges {
          node {
            id
            processedAt
            lineItems(first: 1) {
              edges {
                node {
                  title
                }
              }
            }
          }
        }
      }
    }
  }
`;

export interface FetchRecentOrdersArgs {
  readonly merchantId: string;
  /**
   * Full Shopify Customer GID (e.g. `gid://shopify/Customer/12345`).
   * Caller passes `customerStateChangedPayload.shopifyCustomerId`
   * directly — already in GID form per the §F-3 producer contract.
   */
  readonly customerId: string;
  /**
   * Max orders to return. Default 3 per §F-9 step 6b ("last 3 paid
   * orders' line items → product titles"). Each order contributes at
   * most one product (its primary line item) to the returned array,
   * so the array length is `≤ take`.
   */
  readonly take?: number;
}

/**
 * Shape returned to the caller. Matches `WinbackPromptArgs.recentProducts`'
 * element type (`RecentProduct = { title: string }`) so the handler can
 * pass the array straight through to `buildWinbackPrompt`.
 */
export interface RecentOrderProduct {
  readonly title: string;
}

/** Internal — raw GraphQL response shape. NOT exported. */
interface RawRecentOrdersResponse {
  customer?: {
    orders?: {
      edges?: readonly {
        node?: {
          id?: string | null;
          processedAt?: string | null;
          lineItems?: {
            edges?: readonly {
              node?: {
                title?: string | null;
              } | null;
            }[] | null;
          } | null;
        } | null;
      }[] | null;
    } | null;
  } | null;
}

const DEFAULT_TAKE = 3;
const ESTIMATED_QUERY_COST = 10;

/**
 * See module header for rationale + defensive-return contract.
 */
export async function fetchRecentOrders(
  client: AdminClient,
  args: FetchRecentOrdersArgs,
): Promise<readonly RecentOrderProduct[]> {
  const first = args.take ?? DEFAULT_TAKE;

  const data = await client.graphql<RawRecentOrdersResponse>(args.merchantId, {
    query: RECENT_PAID_ORDERS_QUERY,
    variables: { customerId: args.customerId, first },
    estimatedCost: ESTIMATED_QUERY_COST,
  });

  // Defensive: customer absent → []. Possible if the customer was
  // deleted on Shopify's side between our local upsert and this call.
  if (data.customer === null || data.customer === undefined) {
    return [];
  }

  const edges = data.customer.orders?.edges ?? [];
  const products: RecentOrderProduct[] = [];
  for (const edge of edges) {
    const lineItemEdges = edge.node?.lineItems?.edges ?? [];
    const firstLineItem = lineItemEdges[0]?.node;
    const title = firstLineItem?.title;
    // Skip orders with no usable primary line item (refunded-only
    // surface, partial backfill, malformed). Other orders in the same
    // response still flow through.
    if (typeof title === 'string' && title.length > 0) {
      products.push({ title });
    }
  }
  return products;
}
