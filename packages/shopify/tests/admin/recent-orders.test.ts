/**
 * Unit tests for `fetchRecentOrders` (Epic F §F-9 step 6b).
 *
 * Mocked-AdminClient pattern (same shape as install-enrichment.test.ts).
 * The point is to exercise the helper's defensive-return contract +
 * the GraphQL call shape (variables, estimatedCost). No real Shopify
 * traffic; the live-API smoke test lives in M3-Smoke.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AdminClient } from '../../src/admin/client.js';
import {
  RECENT_PAID_ORDERS_QUERY,
  fetchRecentOrders,
} from '../../src/admin/recent-orders.js';

// ---------------------------------------------------------------------------
// Mock-client helpers
// ---------------------------------------------------------------------------

interface OrderFixture {
  readonly id: string;
  readonly title: string;
}

/**
 * Build a fake AdminClient whose `graphql` returns the canonical
 * RecentPaidOrders response shape for the given orders. Each fixture
 * order becomes one edge with a single line item.
 */
function makeMockClient(orders: readonly OrderFixture[]): {
  client: AdminClient;
  graphqlSpy: ReturnType<typeof vi.fn>;
} {
  const graphqlSpy = vi.fn().mockResolvedValue({
    customer: {
      orders: {
        edges: orders.map((o) => ({
          node: {
            id: o.id,
            processedAt: '2026-05-01T00:00:00Z',
            lineItems: {
              edges: [{ node: { title: o.title } }],
            },
          },
        })),
      },
    },
  });
  return { client: { graphql: graphqlSpy } as unknown as AdminClient, graphqlSpy };
}

const MERCHANT_ID = 'm_test';
const CUSTOMER_GID = 'gid://shopify/Customer/12345';

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('fetchRecentOrders — happy path', () => {
  it('returns titles of the 3 most-recent paid orders\' primary line items', async () => {
    const { client } = makeMockClient([
      { id: 'gid://shopify/Order/1', title: 'Sneakers' },
      { id: 'gid://shopify/Order/2', title: 'Hoodie' },
      { id: 'gid://shopify/Order/3', title: 'Socks' },
    ]);

    const result = await fetchRecentOrders(client, {
      merchantId: MERCHANT_ID,
      customerId: CUSTOMER_GID,
    });

    expect(result).toEqual([
      { title: 'Sneakers' },
      { title: 'Hoodie' },
      { title: 'Socks' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Defensive returns
// ---------------------------------------------------------------------------

describe('fetchRecentOrders — defensive returns', () => {
  it('returns [] when customer is null (deleted between local upsert + API call)', async () => {
    const graphqlSpy = vi.fn().mockResolvedValue({ customer: null });
    const client = { graphql: graphqlSpy } as unknown as AdminClient;

    const result = await fetchRecentOrders(client, {
      merchantId: MERCHANT_ID,
      customerId: CUSTOMER_GID,
    });

    expect(result).toEqual([]);
  });

  it('returns [] when customer has no paid orders (empty edges)', async () => {
    const { client } = makeMockClient([]);
    const result = await fetchRecentOrders(client, {
      merchantId: MERCHANT_ID,
      customerId: CUSTOMER_GID,
    });
    expect(result).toEqual([]);
  });

  it('skips orders with empty lineItems (refunded-only / malformed) and returns the rest', async () => {
    // Mixed response: order 1 has a line item, order 2 has empty
    // lineItems.edges, order 3 has a line item. The result MUST include
    // orders 1 + 3 only, in order.
    const graphqlSpy = vi.fn().mockResolvedValue({
      customer: {
        orders: {
          edges: [
            {
              node: {
                id: 'gid://shopify/Order/1',
                processedAt: '2026-05-03T00:00:00Z',
                lineItems: { edges: [{ node: { title: 'Sneakers' } }] },
              },
            },
            {
              node: {
                id: 'gid://shopify/Order/2',
                processedAt: '2026-05-02T00:00:00Z',
                lineItems: { edges: [] }, // ← skipped
              },
            },
            {
              node: {
                id: 'gid://shopify/Order/3',
                processedAt: '2026-05-01T00:00:00Z',
                lineItems: { edges: [{ node: { title: 'Socks' } }] },
              },
            },
          ],
        },
      },
    });
    const client = { graphql: graphqlSpy } as unknown as AdminClient;

    const result = await fetchRecentOrders(client, {
      merchantId: MERCHANT_ID,
      customerId: CUSTOMER_GID,
    });

    expect(result).toEqual([{ title: 'Sneakers' }, { title: 'Socks' }]);
  });
});

// ---------------------------------------------------------------------------
// GraphQL call shape — variables + estimatedCost + query identity
// ---------------------------------------------------------------------------

describe('fetchRecentOrders — GraphQL call shape', () => {
  it('passes the customerId GID and the take value to variables.first', async () => {
    const { client, graphqlSpy } = makeMockClient([
      { id: 'gid://shopify/Order/1', title: 'Sneakers' },
    ]);

    await fetchRecentOrders(client, {
      merchantId: MERCHANT_ID,
      customerId: CUSTOMER_GID,
      take: 5,
    });

    expect(graphqlSpy).toHaveBeenCalledTimes(1);
    const call = graphqlSpy.mock.calls[0] as unknown as [
      string,
      { query: string; variables: { customerId: string; first: number }; estimatedCost: number },
    ];
    expect(call[0]).toBe(MERCHANT_ID);
    expect(call[1].variables.customerId).toBe(CUSTOMER_GID);
    expect(call[1].variables.first).toBe(5);
  });

  it('defaults take to 3 when omitted (§F-9 step 6b "last 3 paid orders")', async () => {
    const { client, graphqlSpy } = makeMockClient([]);

    await fetchRecentOrders(client, {
      merchantId: MERCHANT_ID,
      customerId: CUSTOMER_GID,
    });

    const call = graphqlSpy.mock.calls[0] as unknown as [
      string,
      { variables: { first: number } },
    ];
    expect(call[1].variables.first).toBe(3);
  });

  it('passes estimatedCost: 10 to client.graphql (leaky-bucket gating)', async () => {
    const { client, graphqlSpy } = makeMockClient([]);

    await fetchRecentOrders(client, {
      merchantId: MERCHANT_ID,
      customerId: CUSTOMER_GID,
    });

    const call = graphqlSpy.mock.calls[0] as unknown as [
      string,
      { estimatedCost: number },
    ];
    expect(call[1].estimatedCost).toBe(10);
  });

  it('uses the exported RECENT_PAID_ORDERS_QUERY constant (regression lock against query drift)', async () => {
    const { client, graphqlSpy } = makeMockClient([]);

    await fetchRecentOrders(client, {
      merchantId: MERCHANT_ID,
      customerId: CUSTOMER_GID,
    });

    const call = graphqlSpy.mock.calls[0] as unknown as [
      string,
      { query: string },
    ];
    expect(call[1].query).toBe(RECENT_PAID_ORDERS_QUERY);
    // Sanity: the exported constant contains the salient pieces of the
    // expected query, so a quiet edit to the const that breaks the
    // semantic surfaces here (paid + sortKey + processedAt + first arg).
    expect(RECENT_PAID_ORDERS_QUERY).toContain('financial_status:paid');
    expect(RECENT_PAID_ORDERS_QUERY).toContain('financial_status:partially_paid');
    expect(RECENT_PAID_ORDERS_QUERY).toContain('sortKey: PROCESSED_AT');
    expect(RECENT_PAID_ORDERS_QUERY).toContain('reverse: true');
    expect(RECENT_PAID_ORDERS_QUERY).toContain('$customerId: ID!');
    expect(RECENT_PAID_ORDERS_QUERY).toContain('$first: Int!');
  });
});
