/**
 * Shim — delegates to the shared test-utils now living in
 * `packages/db/src/test-utils.ts`, imported via the
 * `@winback/db/test-utils` sub-export.
 *
 * Pre-extraction this file owned the helpers in duplicate with
 * `packages/db/tests/integration/setup.ts`. The drainer harness (third
 * caller) triggered the session-1 extraction condition; see
 * `packages/db/src/test-utils.ts` header for the full context.
 *
 * `Session.deleteMany` (originally apps/web-specific because the OAuth
 * callback writes Session rows that Merchant cascade doesn't reach) is
 * now part of the shared `resetDb`. apps/web behavior unchanged.
 */
export {
  assertRead,
  createTestMerchant,
  getTestClient,
  resetDb,
} from '@winback/db/test-utils';
