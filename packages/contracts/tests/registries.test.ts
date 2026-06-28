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
  ALL_QUEUE_NAMES,
  ALL_SYSTEM_SCOPE_REASONS,
  AUDIT_ACTIONS,
  BACKFILL_RESOURCES,
  MAX_OUTBOX_ATTEMPTS,
  OUTBOX_EVENTS,
  QUEUE_NAMES,
  SYSTEM_SCOPE_REASONS,
  isAuditAction,
  isBackfillResource,
  isQueueName,
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

  it('MAX_OUTBOX_ATTEMPTS is exactly 10 (D4 regression lock)', () => {
    // Locked at 10 per the D4 design pass. Compared at the drainer as
    // `(row.attempts + 1) >= MAX_OUTBOX_ATTEMPTS` — i.e. the would-be
    // next attempts value, NOT the stored pre-failure value. If this
    // value changes, audit every drainer test that constructs a row
    // with a specific `attempts` field to verify the new boundary.
    expect(MAX_OUTBOX_ATTEMPTS).toBe(10);
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

  it('contains the seventeen actions currently emitted (6 C6 gdpr + 2 D4 outbox + 1 Epic E session 2 customer + 1 A1a merchant + 4 ai: 3 Epic F batch 4 + 1 A2 + 1 A4 discount + 2 Epic G batch 8.4 dispatch)', () => {
    expect(ALL_AUDIT_ACTIONS.size).toBe(17);
    expect(AUDIT_ACTIONS.gdpr.customer_data_request).toBe('gdpr.customer_data_request');
    expect(AUDIT_ACTIONS.gdpr.customer_redact).toBe('gdpr.customer_redact');
    expect(AUDIT_ACTIONS.gdpr.customer_redact_malformed).toBe('gdpr.customer_redact_malformed');
    expect(AUDIT_ACTIONS.gdpr.customer_redact_no_local_record).toBe(
      'gdpr.customer_redact_no_local_record',
    );
    expect(AUDIT_ACTIONS.gdpr.shop_redact).toBe('gdpr.shop_redact');
    expect(AUDIT_ACTIONS.gdpr.shop_redact_idempotent).toBe('gdpr.shop_redact_idempotent');
    expect(AUDIT_ACTIONS.outbox.replay).toBe('outbox.replay');
    expect(AUDIT_ACTIONS.outbox.dead_letter_forced).toBe('outbox.dead_letter_forced');
    expect(AUDIT_ACTIONS.customer.state_changed).toBe('customer.state_changed');
    // A1a (POST-EPIC-F §1 / Lock V10) — first-pass scoring complete. Written
    // by the bulk-rescore pass (A1b) at the scoringInitializedAt flag-flip.
    expect(AUDIT_ACTIONS.merchant.scoring_initialized).toBe('merchant.scoring_initialized');
    // Epic F batch 4 — AI generation pipeline outcomes. See
    // EPIC-F-DESIGN.md §F-8 / §F-9 for the producer call sites.
    expect(AUDIT_ACTIONS.ai.generation_failed).toBe('ai.generation_failed');
    expect(AUDIT_ACTIONS.ai.spend_cap_exceeded).toBe('ai.spend_cap_exceeded');
    expect(AUDIT_ACTIONS.ai.content_blocked).toBe('ai.content_blocked');
    // A2 (POST-EPIC-F §2) — per-merchant hourly generation cap denial.
    // Written by handleCustomerStateChanged STEP 4.5 BEFORE the spend-cap
    // check (cheap Redis-INCR rejection before any DB write).
    expect(AUDIT_ACTIONS.ai.rate_limited).toBe('ai.rate_limited');
    // A4 (POST-EPIC-F §4 batch 4.2) — winback discount minted. Written by the
    // AI Worker in the same tx as the AiGeneration completion.
    expect(AUDIT_ACTIONS.discount.created).toBe('discount.created');
    // Epic G batch 8.4 — dispatch (send) lifecycle. Both written inside the
    // shared `CampaignRepository.markSentWithQuota` completion-tx (worker
    // happy path + 8.5's future SNS Delivery handler call the same method).
    // `suppressed_by_ses` is a SES account-suppression hit — distinct from
    // gate-driven suppressions (which carry no audit; the CampaignTarget's
    // suppressedByGate is the forensic record for those).
    expect(AUDIT_ACTIONS.dispatch.sent).toBe('dispatch.sent');
    expect(AUDIT_ACTIONS.dispatch.suppressed_by_ses).toBe('dispatch.suppressed_by_ses');
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
    expect(isSystemScopeReason('')).toBe(false);
    // Note: `outbox.drain` is intentionally registered in BOTH
    // SYSTEM_SCOPE_REASONS (D2 drainer scope) and QUEUE_NAMES (D1 queue).
    // Same literal, two registries — coincidence, not coupling.
  });

  it('contains the sixteen reasons currently used across the codebase', () => {
    expect(ALL_SYSTEM_SCOPE_REASONS.size).toBe(16);
    expect(SYSTEM_SCOPE_REASONS.admin.token_resolve).toBe('admin.token_resolve');
    expect(SYSTEM_SCOPE_REASONS.admin.token_revoke).toBe('admin.token_revoke');
    expect(SYSTEM_SCOPE_REASONS.gdpr.shop_redact).toBe('gdpr.shop_redact');
    expect(SYSTEM_SCOPE_REASONS.outbox.drain).toBe('outbox.drain');
    expect(SYSTEM_SCOPE_REASONS.outbox.replay).toBe('outbox.replay');
    expect(SYSTEM_SCOPE_REASONS.outbox.dead_letter).toBe('outbox.dead_letter');
    expect(SYSTEM_SCOPE_REASONS.rollup.daily).toBe('rollup.daily');
    expect(SYSTEM_SCOPE_REASONS.enrichment.sweep).toBe('enrichment.sweep');
    // Decay-rescore sweep (post-Epic-F) — daily steady-state companion to §1.
    expect(SYSTEM_SCOPE_REASONS.scoring.decay_sweep).toBe('scoring.decay_sweep');
    // Epic G batch 8.2 — campaign dispatch sweep cross-tenant merchant SELECT.
    expect(SYSTEM_SCOPE_REASONS.campaign.dispatch_sweep).toBe('campaign.dispatch_sweep');
    expect(SYSTEM_SCOPE_REASONS.shopify.install).toBe('shopify.install');
    expect(SYSTEM_SCOPE_REASONS.webhook.ingest).toBe('webhook.ingest');
    expect(SYSTEM_SCOPE_REASONS.healthcheck.readyz).toBe('healthcheck.readyz');
    expect(SYSTEM_SCOPE_REASONS.web.index_lookup).toBe('web.index_lookup');
    // S-5 per-route reasons (POINTS-TO-CONSIDER, resolved 2026-05-23).
    expect(SYSTEM_SCOPE_REASONS.web.customers_lookup).toBe('web.customers_lookup');
    expect(SYSTEM_SCOPE_REASONS.web.settings_lookup).toBe('web.settings_lookup');
  });
});

// ===========================================================================
// QUEUE_NAMES
// ===========================================================================

describe('QUEUE_NAMES registry', () => {
  it('every value matches the canonical <domain>.<action> format', () => {
    for (const value of flattenConst(QUEUE_NAMES)) {
      expect(value, value).toMatch(CANONICAL_FORMAT);
    }
  });

  it('ALL_QUEUE_NAMES cardinality matches the flattened const', () => {
    expect(ALL_QUEUE_NAMES.size).toBe(flattenConst(QUEUE_NAMES).length);
  });

  it('ALL_QUEUE_NAMES contains every value from the const', () => {
    for (const value of flattenConst(QUEUE_NAMES)) {
      expect(ALL_QUEUE_NAMES.has(value as never)).toBe(true);
    }
  });

  it('isQueueName is consistent with ALL_QUEUE_NAMES', () => {
    for (const value of flattenConst(QUEUE_NAMES)) {
      expect(isQueueName(value)).toBe(true);
    }
    // Regression for Q-1a — single-segment names rejected. Locks the
    // decision that the queue registry uses the dotted format the three
    // other registries use, not the BACKFILL_RESOURCES flat format.
    expect(isQueueName('attribution')).toBe(false);
    expect(isQueueName('outbox')).toBe(false);
    expect(isQueueName('cron')).toBe(false);
    expect(isQueueName('')).toBe(false);
    expect(isQueueName('Outbox.Drain')).toBe(false); // caps rejected by format
  });

  it('contains the five queues currently used across the codebase', () => {
    expect(ALL_QUEUE_NAMES.size).toBe(5);
    expect(QUEUE_NAMES.outbox.drain).toBe('outbox.drain');
    expect(QUEUE_NAMES.cron.rollup).toBe('cron.rollup');
    expect(QUEUE_NAMES.cron.sweep).toBe('cron.sweep');
    // Epic F batch 1 — `ai.generate` BullMQ queue. Producer = drainer
    // `customer.state_changed` handler (batch 4). Consumer = AI Worker
    // inside `apps/drainer` (batch 4). Carries `{ aiGenerationId,
    // merchantId, customerId }`.
    expect(QUEUE_NAMES.ai.generate).toBe('ai.generate');
    // Epic G batch 8.2 — `campaign.dispatch` BullMQ queue. Producer =
    // scheduler `dispatch-sweep` tick (per draft). Consumer = dispatch
    // Worker inside `apps/drainer`. Carries `{ merchantId, messageId,
    // campaignId, customerId }`.
    expect(QUEUE_NAMES.campaign.dispatch).toBe('campaign.dispatch');
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
