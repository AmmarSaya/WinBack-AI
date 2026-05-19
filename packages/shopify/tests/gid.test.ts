import { describe, expect, it } from 'vitest';

import {
  toShopifyCustomerGid,
  toShopifyLineItemGid,
  toShopifyOrderGid,
  toShopifyProductGid,
  toShopifyVariantGid,
} from '../src/gid.js';

/**
 * Tests for the five `toShopify<Resource>Gid` wrap helpers.
 *
 * All five share the same private `wrap()` impl in `gid.ts` — one
 * `describe` per resource keeps regression coverage explicit and makes
 * test-name grep trivial. Coverage shape per helper:
 *   - happy path: numeric input → correctly-prefixed GID
 *   - silent-passthrough invariant: non-numeric input → null (no throw)
 *   - sign-handling: negative inputs → null (regex rejects leading `-`)
 *
 * History: pre-Epic-E only `toCustomerGid` existed in
 * `../src/backfill/customer-backfill.ts`. Tests for it lived in
 * `backfill-runner.test.ts`. Epic E session 1 consolidated all five
 * into `gid.ts` and moved the tests here for locality.
 */

const HELPERS = [
  { fn: toShopifyCustomerGid, resource: 'Customer' },
  { fn: toShopifyOrderGid, resource: 'Order' },
  { fn: toShopifyProductGid, resource: 'Product' },
  { fn: toShopifyVariantGid, resource: 'ProductVariant' },
  { fn: toShopifyLineItemGid, resource: 'LineItem' },
] as const;

describe('toShopify<Resource>Gid — wrap helpers', () => {
  for (const { fn, resource } of HELPERS) {
    describe(fn.name, () => {
      it(`wraps a numeric id into a ${resource} GID`, () => {
        expect(fn('12345')).toBe(`gid://shopify/${resource}/12345`);
        expect(fn(67890)).toBe(`gid://shopify/${resource}/67890`);
      });

      it('returns null on non-numeric input (no silent passthrough)', () => {
        expect(fn('abc')).toBeNull();
        expect(fn('12.5')).toBeNull();
        expect(fn('')).toBeNull();
        expect(fn('1 2 3')).toBeNull();
      });

      it('returns null on negative numbers (regex rejects leading `-`)', () => {
        expect(fn(-1)).toBeNull();
        expect(fn(-12345)).toBeNull();
        expect(fn('-1')).toBeNull();
      });
    });
  }
});
