import { describe, expect, it, vi, type Mock } from 'vitest';

import type { AdminClient } from '../../src/admin/client.js';
import { createWinbackDiscountCode } from '../../src/admin/discounts.js';
import { ShopifyAdminApiError } from '../../src/admin/errors.js';

interface GraphqlArgs {
  query: string;
  variables?: Record<string, unknown>;
}
type GraphqlHandler = (merchantId: string, args: GraphqlArgs) => unknown;

function makeClient(handler: GraphqlHandler): { client: AdminClient; graphql: Mock } {
  const graphql = vi.fn(async (merchantId: string, args: GraphqlArgs) =>
    handler(merchantId, args),
  );
  return { client: { graphql } as unknown as AdminClient, graphql };
}

/** Extracts the `input` variable from the Nth graphql call (default last). */
function inputOf(graphql: Mock, callIndex = 0): Record<string, unknown> {
  const call = graphql.mock.calls[callIndex] as [string, GraphqlArgs] | undefined;
  const variables = call?.[1].variables as { input?: Record<string, unknown> } | undefined;
  return variables?.input ?? {};
}

const BASE_ARGS = {
  merchantId: 'm_1',
  customerGid: 'gid://shopify/Customer/42',
  code: 'WB-ABCDEFGH12345678',
  valuePercent: 15,
  endsAt: new Date('2026-06-24T12:00:00.000Z'),
  startsAt: new Date('2026-06-10T12:00:00.000Z'),
};

const TAKEN_ERROR = {
  field: ['basicCodeDiscount', 'code'],
  code: 'TAKEN',
  message: 'Code must be unique',
};

describe('createWinbackDiscountCode', () => {
  it('happy path → customer-scoped input (percentage = valuePercent/100, appliesOncePerCustomer, endsAt) + created node id; no lookup', async () => {
    const { client, graphql } = makeClient((_m, args) => {
      expect(args.query).toContain('discountCodeBasicCreate');
      return {
        discountCodeBasicCreate: {
          codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/1' },
          userErrors: [],
        },
      };
    });

    const result = await createWinbackDiscountCode(client, BASE_ARGS);

    expect(result).toEqual({
      code: BASE_ARGS.code,
      shopifyDiscountId: 'gid://shopify/DiscountCodeNode/1',
      alreadyExisted: false,
    });

    const input = inputOf(graphql);
    expect(input.code).toBe(BASE_ARGS.code);
    expect(input.appliesOncePerCustomer).toBe(true);
    expect(input.endsAt).toBe('2026-06-24T12:00:00.000Z');
    expect(input.startsAt).toBe('2026-06-10T12:00:00.000Z');
    expect(input.customerSelection).toEqual({
      customers: { add: ['gid://shopify/Customer/42'] },
    });
    const customerGets = input.customerGets as {
      value: { percentage: number };
      items: { all: boolean };
    };
    expect(customerGets.value.percentage).toBe(0.15);
    expect(customerGets.items.all).toBe(true);

    // No TAKEN → no lookup call.
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it('TAKEN → recovers existing id via codeDiscountNodeByCode (idempotent self-heal, alreadyExisted=true)', async () => {
    const { client, graphql } = makeClient((_m, args) => {
      if (args.query.includes('discountCodeBasicCreate')) {
        return {
          discountCodeBasicCreate: {
            codeDiscountNode: null,
            userErrors: [TAKEN_ERROR],
          },
        };
      }
      // Lookup branch.
      expect(args.query).toContain('codeDiscountNodeByCode');
      expect(args.variables).toEqual({ code: BASE_ARGS.code });
      return { codeDiscountNodeByCode: { id: 'gid://shopify/DiscountCodeNode/existing' } };
    });

    const result = await createWinbackDiscountCode(client, BASE_ARGS);

    expect(result).toEqual({
      code: BASE_ARGS.code,
      shopifyDiscountId: 'gid://shopify/DiscountCodeNode/existing',
      alreadyExisted: true,
    });
    expect(graphql).toHaveBeenCalledTimes(2); // create + lookup
  });

  it('TAKEN but lookup finds no node → throws ShopifyAdminApiError (Shopify state we do not understand)', async () => {
    const { client } = makeClient((_m, args) => {
      if (args.query.includes('discountCodeBasicCreate')) {
        return {
          discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [TAKEN_ERROR] },
        };
      }
      return { codeDiscountNodeByCode: null };
    });

    await expect(createWinbackDiscountCode(client, BASE_ARGS)).rejects.toBeInstanceOf(
      ShopifyAdminApiError,
    );
  });

  it('non-TAKEN userError → throws ShopifyAdminApiError WITHOUT attempting a lookup (fail loud)', async () => {
    const { client, graphql } = makeClient((_m, args) => {
      expect(args.query).toContain('discountCodeBasicCreate');
      return {
        discountCodeBasicCreate: {
          codeDiscountNode: null,
          userErrors: [
            { field: ['basicCodeDiscount', 'customerGets'], code: 'INVALID', message: 'bad' },
          ],
        },
      };
    });

    await expect(createWinbackDiscountCode(client, BASE_ARGS)).rejects.toBeInstanceOf(
      ShopifyAdminApiError,
    );
    expect(graphql).toHaveBeenCalledTimes(1); // no lookup attempted
  });

  it('defaults startsAt (now) + a recognizable title when omitted', async () => {
    const { client, graphql } = makeClient(() => ({
      discountCodeBasicCreate: {
        codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/9' },
        userErrors: [],
      },
    }));

    await createWinbackDiscountCode(client, {
      merchantId: 'm_1',
      customerGid: 'gid://shopify/Customer/1',
      code: 'WB-CODE0000000000',
      valuePercent: 10,
      endsAt: new Date('2026-07-01T00:00:00.000Z'),
    });

    const input = inputOf(graphql);
    expect(typeof input.startsAt).toBe('string');
    expect(input.title).toContain('WB-CODE0000000000');
    const customerGets = input.customerGets as { value: { percentage: number } };
    expect(customerGets.value.percentage).toBe(0.1);
  });
});
