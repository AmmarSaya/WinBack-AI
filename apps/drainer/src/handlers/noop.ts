import type { OutboxEventRow } from '@winback/db';
import { getLogger } from '@winback/logger';

const log = getLogger('drainer.handler.noop');

/**
 * Generic noop handler. Logs at debug + returns. Used for event types
 * with no consumer in D2:
 *
 *   - customer.* (created/updated/deleted/redacted/state_changed)
 *   - product.* (created/updated/deleted)
 *   - order.cancelled, order.refunded
 *   - merchant.uninstalled, merchant.needs_reauth,
 *     merchant.shop_details_fetched, merchant.backfill_completed
 *
 * Honesty over silence: we log at debug level so production logs show
 * "drainer saw and skipped this event type" rather than implying it was
 * processed. When a future epic adds a real handler, the dispatch entry
 * moves from `noop` to the new handler module.
 */
export async function handleNoop(row: OutboxEventRow): Promise<void> {
  log.debug({ eventId: row.id, type: row.type, merchantId: row.merchantId }, 'noop');
  // Explicitly nothing to do. Resolved Promise.
  return Promise.resolve();
}
