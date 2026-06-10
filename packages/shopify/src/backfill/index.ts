export { BackfillRunner, type BackfillRunnerOptions } from './runner.js';
export {
  CUSTOMER_BACKFILL_RESOURCE,
  CustomerPageFetcher,
  CustomerPageProcessor,
  extractNumericIdFromGid,
  parseDateOrNull,
  parseGid,
  parseIntOrZero,
  type ShopifyCustomerNode,
} from './customer-backfill.js';
// `toCustomerGid` was removed from this module in Epic E session 1 and
// renamed to `toShopifyCustomerGid` in `../gid.js`, exported via the
// top-level `@winback/shopify` package surface alongside its four siblings.
export {
  ORDER_BACKFILL_RESOURCE,
  OrderPageFetcher,
  OrderPageProcessor,
  mapOrderNodeToWebhookBody,
  KNOWN_GRAPHQL_FINANCIAL_STATUSES,
  type ShopifyOrderNode,
} from './order-backfill.js';
export { enrichInstall, type EnrichInstallResult } from './install-enrichment.js';
export type {
  BackfillRunResult,
  PageFetcher,
  PageProcessor,
  ResourcePage,
} from './types.js';
