export {
  processCustomerDataRequest,
  processCustomerRedact,
  processShopRedact,
  DEFAULT_SHOP_REDACT_BATCH_SIZE,
  // B2 exports — consumed by the apps/drainer integration test via
  // the package boundary. SHOP_REDACT_TABLES_IN_ORDER stays internal
  // (its only consumer is the registry-shape test which uses a
  // relative path); add it here if a future consumer needs it.
  CUSTOMER_REDACT_CHILD_TABLES,
  REDACTED_GID_SENTINEL_PREFIX,
  type CustomerDataRequestPayload,
  type CustomerRedactPayload,
  type ShopRedactPayload,
  type ProcessCustomerDataRequestArgs,
  type ProcessCustomerRedactArgs,
  type ProcessShopRedactArgs,
} from './gdpr-processor.js';
