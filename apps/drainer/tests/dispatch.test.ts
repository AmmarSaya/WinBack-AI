/**
 * Exhaustiveness tests for `dispatchEvent`.
 *
 * The goal is to verify that every member of `ALL_OUTBOX_EVENT_TYPES`
 * routes somewhere (no fall-through) and that unknown types throw
 * ValidationError.
 *
 * Real handlers are mocked at module load. We assert which handler
 * function was called for each event type. Mocking is necessary
 * because the real handlers have heavy deps (Prisma, AdminClient,
 * Shopify GraphQL).
 */

import { ALL_OUTBOX_EVENT_TYPES, OUTBOX_EVENTS } from '@winback/contracts';
import type { OutboxEventRow } from '@winback/db';
import { ValidationError } from '@winback/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock every handler module BEFORE importing dispatchEvent.
vi.mock('../src/handlers/customer.js', () => ({
  handleCustomerCreated: vi.fn().mockResolvedValue(undefined),
  handleCustomerUpdated: vi.fn().mockResolvedValue(undefined),
  handleCustomerDeleted: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/handlers/customer-state-changed.js', () => ({
  handleCustomerStateChanged: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/handlers/gdpr.js', () => ({
  handleCustomerDataRequested: vi.fn().mockResolvedValue(undefined),
  handleCustomerRedacted: vi.fn().mockResolvedValue(undefined),
  handleShopRedacted: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/handlers/merchant.js', () => ({
  handleMerchantInstalled: vi.fn().mockResolvedValue(undefined),
  handleMerchantUninstalled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/handlers/noop.js', () => ({
  handleNoop: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/handlers/order.js', () => ({
  handleOrderEvent: vi.fn().mockResolvedValue(undefined),
  handleOrderNoop: vi.fn().mockResolvedValue(undefined),
}));

// Imports AFTER mocks so dispatch sees the mocked handlers.
const { dispatchEvent } = await import('../src/dispatch.js');
const customerMod = await import('../src/handlers/customer.js');
const customerStateChangedMod = await import('../src/handlers/customer-state-changed.js');
const gdprMod = await import('../src/handlers/gdpr.js');
const merchantMod = await import('../src/handlers/merchant.js');
const noopMod = await import('../src/handlers/noop.js');
const orderMod = await import('../src/handlers/order.js');

function makeRow(type: string): OutboxEventRow {
  return {
    id: 'row-' + type,
    merchantId: 'merchant-1',
    type,
    payload: {},
    createdAt: new Date(),
    attempts: 0,
  };
}

const stubCtx = {
  prisma: {},
  queues: {},
  shopifyConfig: {},
} as unknown as Parameters<typeof dispatchEvent>[0];

afterEach(() => {
  vi.clearAllMocks();
});

describe('dispatchEvent — exhaustiveness', () => {
  it('routes every member of ALL_OUTBOX_EVENT_TYPES without throwing', async () => {
    for (const type of ALL_OUTBOX_EVENT_TYPES) {
      await expect(dispatchEvent(stubCtx, makeRow(type))).resolves.not.toThrow();
    }
  });
});

describe('dispatchEvent — handler routing', () => {
  it('merchant.installed → handleMerchantInstalled', async () => {
    await dispatchEvent(stubCtx, makeRow(OUTBOX_EVENTS.merchant.installed));
    expect(merchantMod.handleMerchantInstalled).toHaveBeenCalledTimes(1);
  });

  it('merchant.uninstalled → handleMerchantUninstalled (NOT noop — pre-D4 fix)', async () => {
    await dispatchEvent(stubCtx, makeRow(OUTBOX_EVENTS.merchant.uninstalled));
    expect(merchantMod.handleMerchantUninstalled).toHaveBeenCalledTimes(1);
    expect(noopMod.handleNoop).not.toHaveBeenCalled();
  });

  it('other merchant.* events → handleNoop', async () => {
    await dispatchEvent(stubCtx, makeRow(OUTBOX_EVENTS.merchant.needs_reauth));
    await dispatchEvent(stubCtx, makeRow(OUTBOX_EVENTS.merchant.shop_details_fetched));
    await dispatchEvent(stubCtx, makeRow(OUTBOX_EVENTS.merchant.backfill_completed));
    // M-9: scopes_updated joins the merchant fall-through trio →
    // 3 → 4 noop routes. v1 handler is intentionally noop; Section 4
    // batch 4.2 may add a real handler when new scopes ship.
    await dispatchEvent(stubCtx, makeRow(OUTBOX_EVENTS.merchant.scopes_updated));
    expect(noopMod.handleNoop).toHaveBeenCalledTimes(4);
    expect(merchantMod.handleMerchantInstalled).not.toHaveBeenCalled();
    expect(merchantMod.handleMerchantUninstalled).not.toHaveBeenCalled();
  });

  it('order.placed → handleOrderEvent with event-type discriminator', async () => {
    await dispatchEvent(stubCtx, makeRow(OUTBOX_EVENTS.order.placed));
    expect(orderMod.handleOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'order.placed',
    );
  });

  it('order.updated → handleOrderEvent with event-type discriminator', async () => {
    await dispatchEvent(stubCtx, makeRow(OUTBOX_EVENTS.order.updated));
    expect(orderMod.handleOrderEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'order.updated',
    );
  });

  it('order.cancelled / order.refunded → handleOrderNoop', async () => {
    await dispatchEvent(stubCtx, makeRow(OUTBOX_EVENTS.order.cancelled));
    await dispatchEvent(stubCtx, makeRow(OUTBOX_EVENTS.order.refunded));
    expect(orderMod.handleOrderNoop).toHaveBeenCalledTimes(2);
  });

  it('customer.created → handleCustomerCreated', async () => {
    await dispatchEvent(stubCtx, makeRow(OUTBOX_EVENTS.customer.created));
    expect(customerMod.handleCustomerCreated).toHaveBeenCalledTimes(1);
    expect(noopMod.handleNoop).not.toHaveBeenCalled();
  });

  it('customer.updated → handleCustomerUpdated', async () => {
    await dispatchEvent(stubCtx, makeRow(OUTBOX_EVENTS.customer.updated));
    expect(customerMod.handleCustomerUpdated).toHaveBeenCalledTimes(1);
  });

  it('customer.deleted → handleCustomerDeleted (non-GDPR soft-delete path)', async () => {
    await dispatchEvent(stubCtx, makeRow(OUTBOX_EVENTS.customer.deleted));
    expect(customerMod.handleCustomerDeleted).toHaveBeenCalledTimes(1);
  });

  it('customer.redacted (non-GDPR; no producer) → handleNoop', async () => {
    await dispatchEvent(stubCtx, makeRow(OUTBOX_EVENTS.customer.redacted));
    expect(noopMod.handleNoop).toHaveBeenCalledTimes(1);
    expect(customerMod.handleCustomerCreated).not.toHaveBeenCalled();
    expect(customerMod.handleCustomerUpdated).not.toHaveBeenCalled();
    expect(customerMod.handleCustomerDeleted).not.toHaveBeenCalled();
  });

  it('customer.state_changed → handleCustomerStateChanged (Epic F §F-9)', async () => {
    await dispatchEvent(stubCtx, makeRow(OUTBOX_EVENTS.customer.state_changed));
    expect(customerStateChangedMod.handleCustomerStateChanged).toHaveBeenCalledTimes(1);
    expect(noopMod.handleNoop).not.toHaveBeenCalled();
    expect(customerMod.handleCustomerCreated).not.toHaveBeenCalled();
  });

  it('all product.* events → handleNoop', async () => {
    for (const t of Object.values(OUTBOX_EVENTS.product)) {
      await dispatchEvent(stubCtx, makeRow(t));
    }
    expect(noopMod.handleNoop).toHaveBeenCalledTimes(Object.values(OUTBOX_EVENTS.product).length);
  });

  it('gdpr events route to their respective adapters', async () => {
    await dispatchEvent(stubCtx, makeRow(OUTBOX_EVENTS.gdpr.customer_data_requested));
    await dispatchEvent(stubCtx, makeRow(OUTBOX_EVENTS.gdpr.customer_redacted));
    await dispatchEvent(stubCtx, makeRow(OUTBOX_EVENTS.gdpr.shop_redacted));
    expect(gdprMod.handleCustomerDataRequested).toHaveBeenCalledTimes(1);
    expect(gdprMod.handleCustomerRedacted).toHaveBeenCalledTimes(1);
    expect(gdprMod.handleShopRedacted).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchEvent — unknown event types', () => {
  it('throws ValidationError for a type not in ALL_OUTBOX_EVENT_TYPES', async () => {
    await expect(
      dispatchEvent(stubCtx, makeRow('something.unregistered')),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
