/**
 * Shape tests for every closed-set registry in @winback/contracts.
 *
 * What we verify here:
 *   - Every registered value follows the canonical `<category>.<action>`
 *     regex (matches the DB CHECK constraint for OutboxEvent.type and the
 *     SYSTEM_REASON_PATTERN in withSystemScope).
 *   - The flat ALL_* Set has exactly the same cardinality as the nested
 *     const — guards against a future edit that adds to the const but
 *     forgets to extend the Set spread (or vice versa).
 *   - The predicate function (isAuditAction / isSystemScopeReason /
 *     isBackfillResource) is consistent with the Set.
 *   - Regression: OUTBOX_EVENTS no longer contains 'audit.entry' (B2 lock).
 */

import { describe, expect, it } from 'vitest';

import {
  ALL_AUDIT_ACTIONS,
  ALL_BACKFILL_RESOURCES,
  ALL_OUTBOX_EVENT_TYPES,
  ALL_SYSTEM_SCOPE_REASONS,
  AUDIT_ACTIONS,
  BACKFILL_RESOURCES,
  OUTBOX_EVENTS,
  SYSTEM_SCOPE_REASONS,
  isAuditAction,
  isBackfillResource,
  isSystemScopeReason,
} from '../src/index.js';

// Matches the T4 DB CHECK constraint and SYSTEM_REASON_PATTERN exactly.
const CANONICAL_FORMAT = /^[a-z][a-z_]*\.[a-z][a-z_0-9]*(@v[0-9]+)?$/;

function flattenConst(obj: Readonly<Record<string, Readonly<Record<string, string>>>>): string[] {
  return Object.values(obj).flatMap((domain) => Object.values(domain));
}

// ===========================================================================
// OUTBOX_EVENTS
// ===========================================================================

describe('OUTBOX_EVENTS registry', () => {
  it('every value matches the canonical <domain>.<event> format', () => {
    for (const value of flattenConst(OUTBOX_EVENTS)) {
      expect(value, value).toMatch(CANONICAL_FORMAT);
    }
  });

  it('ALL_OUTBOX_EVENT_TYPES cardinality matches the flattened const', () => {
    expect(ALL_OUTBOX_EVENT_TYPES.size).toBe(flattenConst(OUTBOX_EVENTS).length);
  });

  it('ALL_OUTBOX_EVENT_TYPES contains every value from the const', () => {
    for (const value of flattenConst(OUTBOX_EVENTS)) {
      expect(ALL_OUTBOX_EVENT_TYPES.has(value as never)).toBe(true);
    }
  });

  it('does NOT contain audit.entry (B2 lock — audit writes are direct, not outbox)', () => {
    expect(ALL_OUTBOX_EVENT_TYPES.has('audit.entry' as never)).toBe(false);
    expect(flattenConst(OUTBOX_EVENTS)).not.toContain('audit.entry');
    // Top-level `audit` key must also be absent — keeping an empty `audit: {}`
    // would invite a future agent to refill it.
    expect(Object.keys(OUTBOX_EVENTS)).not.toContain('audit');
  });

  it('preserves the gdpr.* domain (C6 ship)', () => {
    expect(ALL_OUTBOX_EVENT_TYPES.has(OUTBOX_EVENTS.gdpr.customer_data_requested)).toBe(true);
    expect(ALL_OUTBOX_EVENT_TYPES.has(OUTBOX_EVENTS.gdpr.customer_redacted)).toBe(true);
    expect(ALL_OUTBOX_EVENT_TYPES.has(OUTBOX_EVENTS.gdpr.shop_redacted)).toBe(true);
  });
});

// ===========================================================================
// AUDIT_ACTIONS
// ===========================================================================

describe('AUDIT_ACTIONS registry', () => {
  it('every value matches the canonical <domain>.<action> format', () => {
    for (const value of flattenConst(AUDIT_ACTIONS)) {
      expect(value, value).toMatch(CANONICAL_FORMAT);
    }
  });

  it('ALL_AUDIT_ACTIONS cardinality matches the flattened const', () => {
    expect(ALL_AUDIT_ACTIONS.size).toBe(flattenConst(AUDIT_ACTIONS).length);
  });

  it('ALL_AUDIT_ACTIONS contains every value from the const', () => {
    for (const value of flattenConst(AUDIT_ACTIONS)) {
      expect(ALL_AUDIT_ACTIONS.has(value as never)).toBe(true);
    }
  });

  it('isAuditAction is consistent with ALL_AUDIT_ACTIONS', () => {
    for (const value of flattenConst(AUDIT_ACTIONS)) {
      expect(isAuditAction(value)).toBe(true);
    }
    expect(isAuditAction('gdpr.not_a_real_action')).toBe(false);
    expect(isAuditAction('')).toBe(false);
    expect(isAuditAction('CapsAreInvalid')).toBe(false);
  });

  it('contains the six C6 gdpr.* actions emitted by the compliance processor', () => {
    expect(ALL_AUDIT_ACTIONS.size).toBe(6);
    expect(AUDIT_ACTIONS.gdpr.customer_data_request).toBe('gdpr.customer_data_request');
    expect(AUDIT_ACTIONS.gdpr.customer_redact).toBe('gdpr.customer_redact');
    expect(AUDIT_ACTIONS.gdpr.customer_redact_malformed).toBe('gdpr.customer_redact_malformed');
    expect(AUDIT_ACTIONS.gdpr.customer_redact_no_local_record).toBe(
      'gdpr.customer_redact_no_local_record',
    );
    expect(AUDIT_ACTIONS.gdpr.shop_redact).toBe('gdpr.shop_redact');
    expect(AUDIT_ACTIONS.gdpr.shop_redact_idempotent).toBe('gdpr.shop_redact_idempotent');
  });
});

// ===========================================================================
// SYSTEM_SCOPE_REASONS
// ===========================================================================

describe('SYSTEM_SCOPE_REASONS registry', () => {
  it('every value matches the canonical <category>.<action> format', () => {
    for (const value of flattenConst(SYSTEM_SCOPE_REASONS)) {
      expect(value, value).toMatch(CANONICAL_FORMAT);
    }
  });

  it('ALL_SYSTEM_SCOPE_REASONS cardinality matches the flattened const', () => {
    expect(ALL_SYSTEM_SCOPE_REASONS.size).toBe(flattenConst(SYSTEM_SCOPE_REASONS).length);
  });

  it('ALL_SYSTEM_SCOPE_REASONS contains every value from the const', () => {
    for (const value of flattenConst(SYSTEM_SCOPE_REASONS)) {
      expect(ALL_SYSTEM_SCOPE_REASONS.has(value as never)).toBe(true);
    }
  });

  it('isSystemScopeReason is consistent with ALL_SYSTEM_SCOPE_REASONS', () => {
    for (const value of flattenConst(SYSTEM_SCOPE_REASONS)) {
      expect(isSystemScopeReason(value)).toBe(true);
    }
    expect(isSystemScopeReason('gdpr.shop_redcat')).toBe(false); // typo
    expect(isSystemScopeReason('outbox.drain')).toBe(false); // not yet registered
    expect(isSystemScopeReason('')).toBe(false);
  });

  it('contains the seven reasons currently used across the codebase', () => {
    expect(ALL_SYSTEM_SCOPE_REASONS.size).toBe(7);
    expect(SYSTEM_SCOPE_REASONS.admin.token_resolve).toBe('admin.token_resolve');
    expect(SYSTEM_SCOPE_REASONS.admin.token_revoke).toBe('admin.token_revoke');
    expect(SYSTEM_SCOPE_REASONS.gdpr.shop_redact).toBe('gdpr.shop_redact');
    expect(SYSTEM_SCOPE_REASONS.shopify.install).toBe('shopify.install');
    expect(SYSTEM_SCOPE_REASONS.webhook.ingest).toBe('webhook.ingest');
    expect(SYSTEM_SCOPE_REASONS.healthcheck.readyz).toBe('healthcheck.readyz');
    expect(SYSTEM_SCOPE_REASONS.web.index_lookup).toBe('web.index_lookup');
  });
});

// ===========================================================================
// BACKFILL_RESOURCES (consistency cross-check; the registry already exists)
// ===========================================================================

describe('BACKFILL_RESOURCES registry', () => {
  it('values are lowercase identifiers', () => {
    for (const value of Object.values(BACKFILL_RESOURCES)) {
      expect(value).toMatch(/^[a-z][a-z_]*$/);
    }
  });

  it('ALL_BACKFILL_RESOURCES cardinality matches the const', () => {
    expect(ALL_BACKFILL_RESOURCES.size).toBe(Object.values(BACKFILL_RESOURCES).length);
  });

  it('isBackfillResource is consistent with ALL_BACKFILL_RESOURCES', () => {
    for (const value of Object.values(BACKFILL_RESOURCES)) {
      expect(isBackfillResource(value)).toBe(true);
    }
    expect(isBackfillResource('not_a_resource')).toBe(false);
    expect(isBackfillResource('')).toBe(false);
  });
});
