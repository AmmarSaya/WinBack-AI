import { OUTBOX_EVENTS } from '@winback/contracts';
import { describe, expect, it } from 'vitest';

import {
  GDPR_TOPICS,
  WEBHOOK_TOPIC_TO_EVENT,
  getOutboxEventForTopic,
  isGdprTopic,
  isKnownTopic,
} from '../src/webhook-topics.js';

describe('webhook topic → outbox event mapping', () => {
  it('maps customer commerce topics', () => {
    expect(getOutboxEventForTopic('customers/create')).toBe(OUTBOX_EVENTS.customer.created);
    expect(getOutboxEventForTopic('customers/update')).toBe(OUTBOX_EVENTS.customer.updated);
    expect(getOutboxEventForTopic('customers/delete')).toBe(OUTBOX_EVENTS.customer.deleted);
  });

  it('maps order topics', () => {
    expect(getOutboxEventForTopic('orders/create')).toBe(OUTBOX_EVENTS.order.placed);
    expect(getOutboxEventForTopic('orders/updated')).toBe(OUTBOX_EVENTS.order.updated);
    expect(getOutboxEventForTopic('orders/cancelled')).toBe(OUTBOX_EVENTS.order.cancelled);
  });

  it('maps product topics', () => {
    expect(getOutboxEventForTopic('products/create')).toBe(OUTBOX_EVENTS.product.created);
    expect(getOutboxEventForTopic('products/update')).toBe(OUTBOX_EVENTS.product.updated);
    expect(getOutboxEventForTopic('products/delete')).toBe(OUTBOX_EVENTS.product.deleted);
  });

  it('maps app lifecycle', () => {
    expect(getOutboxEventForTopic('app/uninstalled')).toBe(OUTBOX_EVENTS.merchant.uninstalled);
  });

  it('returns null for GDPR topics (C3 logs only; C6 processes)', () => {
    expect(getOutboxEventForTopic('customers/data_request')).toBeNull();
    expect(getOutboxEventForTopic('customers/redact')).toBeNull();
    expect(getOutboxEventForTopic('shop/redact')).toBeNull();
  });

  it('returns null for unknown topics', () => {
    expect(getOutboxEventForTopic('orders/fulfilled')).toBeNull();
    expect(getOutboxEventForTopic('not/a/topic')).toBeNull();
    expect(getOutboxEventForTopic('')).toBeNull();
  });
});

describe('GDPR topic classification', () => {
  it('isGdprTopic accepts the three Shopify-mandatory topics', () => {
    expect(isGdprTopic('customers/data_request')).toBe(true);
    expect(isGdprTopic('customers/redact')).toBe(true);
    expect(isGdprTopic('shop/redact')).toBe(true);
  });

  it('isGdprTopic rejects commerce topics', () => {
    expect(isGdprTopic('customers/create')).toBe(false);
    expect(isGdprTopic('orders/create')).toBe(false);
  });

  it('GDPR_TOPICS set contains exactly the three Shopify-mandatory topics', () => {
    expect(GDPR_TOPICS.size).toBe(3);
  });
});

describe('isKnownTopic', () => {
  it('accepts commerce + GDPR topics', () => {
    expect(isKnownTopic('orders/create')).toBe(true);
    expect(isKnownTopic('customers/redact')).toBe(true);
    expect(isKnownTopic('app/uninstalled')).toBe(true);
  });

  it('rejects unknown topics', () => {
    expect(isKnownTopic('foo/bar')).toBe(false);
    expect(isKnownTopic('')).toBe(false);
  });
});

describe('WEBHOOK_TOPIC_TO_EVENT shape', () => {
  it('every mapped value is a non-empty string', () => {
    for (const [topic, event] of Object.entries(WEBHOOK_TOPIC_TO_EVENT)) {
      expect(typeof event).toBe('string');
      expect(event.length).toBeGreaterThan(0);
      expect(topic.length).toBeGreaterThan(0);
    }
  });
});
