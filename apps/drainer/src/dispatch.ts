/**
 * Per-event-type dispatcher. Exhaustive switch over `OUTBOX_EVENTS`
 * keyed by `row.type` (a string from the DB raw-query). Each branch
 * routes to a handler module under `./handlers/`.
 *
 * EXHAUSTIVENESS: the final `assertNever(eventType)` ensures every
 * member of `OutboxEventType` is handled. Adding a new event type
 * without updating this switch is a compile error.
 *
 * UNKNOWN TYPES: a row whose `type` is not a member of
 * `ALL_OUTBOX_EVENT_TYPES` (e.g. a producer that wrote a string
 * outside the registry — a CHECK-constraint bypass or a stale row
 * from a removed event) throws `ValidationError`. The drainer catches
 * and markFails the row.
 */

import {
  ALL_OUTBOX_EVENT_TYPES,
  OUTBOX_EVENTS,
  type OutboxEventType,
} from '@winback/contracts';
import type { OutboxEventRow } from '@winback/db';
import { ValidationError } from '@winback/errors';

import type { DrainerContext } from './context.js';
import {
  handleCustomerDataRequested,
  handleCustomerRedacted,
  handleShopRedacted,
} from './handlers/gdpr.js';
import { handleMerchantInstalled, handleMerchantUninstalled } from './handlers/merchant.js';
import { handleNoop } from './handlers/noop.js';
import { handleOrderEvent, handleOrderNoop } from './handlers/order.js';

export async function dispatchEvent(
  ctx: DrainerContext,
  row: OutboxEventRow,
): Promise<void> {
  if (!ALL_OUTBOX_EVENT_TYPES.has(row.type as OutboxEventType)) {
    throw new ValidationError(`Unknown outbox event type: ${row.type}`, {
      fields: { type: row.type, eventId: row.id },
    });
  }

  const eventType = row.type as OutboxEventType;

  switch (eventType) {
    // --- merchant ---------------------------------------------------------
    case OUTBOX_EVENTS.merchant.installed:
      return handleMerchantInstalled(ctx, row);
    case OUTBOX_EVENTS.merchant.uninstalled:
      return handleMerchantUninstalled(ctx, row);
    case OUTBOX_EVENTS.merchant.needs_reauth:
    case OUTBOX_EVENTS.merchant.shop_details_fetched:
    case OUTBOX_EVENTS.merchant.backfill_completed:
      return handleNoop(row);

    // --- customer ---------------------------------------------------------
    case OUTBOX_EVENTS.customer.created:
    case OUTBOX_EVENTS.customer.updated:
    case OUTBOX_EVENTS.customer.deleted:
    case OUTBOX_EVENTS.customer.redacted:
    case OUTBOX_EVENTS.customer.state_changed:
      return handleNoop(row);

    // --- order ------------------------------------------------------------
    case OUTBOX_EVENTS.order.placed:
      return handleOrderEvent(ctx, row, 'order.placed');
    case OUTBOX_EVENTS.order.updated:
      return handleOrderEvent(ctx, row, 'order.updated');
    case OUTBOX_EVENTS.order.cancelled:
    case OUTBOX_EVENTS.order.refunded:
      return handleOrderNoop(row);

    // --- product ----------------------------------------------------------
    case OUTBOX_EVENTS.product.created:
    case OUTBOX_EVENTS.product.updated:
    case OUTBOX_EVENTS.product.deleted:
      return handleNoop(row);

    // --- gdpr -------------------------------------------------------------
    case OUTBOX_EVENTS.gdpr.customer_data_requested:
      return handleCustomerDataRequested(ctx, row);
    case OUTBOX_EVENTS.gdpr.customer_redacted:
      return handleCustomerRedacted(ctx, row);
    case OUTBOX_EVENTS.gdpr.shop_redacted:
      return handleShopRedacted(ctx, row);

    default:
      // Exhaustiveness check: if a new member is added to OutboxEventType
      // without a case here, TS marks this as `never`-typed and the
      // assignment fails to compile.
      return assertNever(eventType);
  }
}

function assertNever(x: never): never {
  throw new Error(`Unhandled outbox event type (compile-time check failed): ${String(x)}`);
}
