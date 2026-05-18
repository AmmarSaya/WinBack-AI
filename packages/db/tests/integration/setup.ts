/**
 * Shim — delegates to the shared test-utils now living in
 * `packages/db/src/test-utils.ts`. Kept as a thin re-export so existing
 * tests inside `packages/db/tests/integration/` don't change their import
 * paths. Cross-package consumers (`apps/web`, `apps/drainer`) import
 * directly from `@winback/db/test-utils` via the package sub-export.
 *
 * Pre-extraction history: this file owned the helpers in duplicate with
 * `apps/web/tests/integration/setup.ts`. The drainer harness (third
 * caller) triggered the session-1 extraction condition; see
 * `packages/db/src/test-utils.ts` header for the full context.
 *
 * Note: the shared `resetDb` now includes `Session.deleteMany` (originally
 * apps/web-only). For db-package tests that don't write Session rows, the
 * extra DELETE on an empty table is sub-ms and irrelevant — single source
 * of truth eliminates drift between consumers when the schema grows.
 */
export {
  assertRead,
  createTestMerchant,
  getTestClient,
  resetDb,
} from '../../src/test-utils.js';
