export { BackfillRunner, type BackfillRunnerOptions } from './runner.js';
export {
  CUSTOMER_BACKFILL_RESOURCE,
  CustomerPageFetcher,
  CustomerPageProcessor,
  extractNumericIdFromGid,
  parseDateOrNull,
  parseGid,
  parseIntOrZero,
  toCustomerGid,
  type ShopifyCustomerNode,
} from './customer-backfill.js';
export { enrichInstall, type EnrichInstallResult } from './install-enrichment.js';
export type {
  BackfillRunResult,
  PageFetcher,
  PageProcessor,
  ResourcePage,
} from './types.js';
