/**
 * AiProviderErrorCode → audit-action mapping documentation + drift gate (B1).
 *
 * Closes audit L6-M2: "AiProviderErrorCode worker-mapping completeness not
 * enforced — new code silently maps to ai.generation_failed."
 *
 * The mapping site lives at
 *   apps/drainer/src/workers/ai-generate.worker.ts:371-374
 *
 * It's intentionally a BINARY classifier, not a per-code table:
 *
 *   const action = err instanceof AiProviderContentBlockedError
 *     ? AUDIT_ACTIONS.ai.content_blocked
 *     : AUDIT_ACTIONS.ai.generation_failed;
 *
 * That design is correct: only `content_blocked` warrants its own audit
 * action (operationally distinct — non-retryable, prompt-design problem,
 * surfaces in policy dashboards). The other four codes are operationally
 * equivalent at the audit-write layer and deliberately fall through.
 *
 * What B1 adds here is NOT a structural refactor. It is a TEST that makes
 * the mapping decision EXPLICIT, DOCUMENTED, and DRIFT-RESISTANT:
 *
 *   1. TypeScript's `Record<AiProviderErrorCode, MappingDecision>` below
 *      forces a compile-time error if AiProviderErrorCode gains a sixth
 *      value without a documented mapping decision. tsc -b goes red; CI
 *      blocks the PR. THIS is the load-bearing gate.
 *
 *   2. The runtime assertions are audit-readable: they print the current
 *      mapping table when a test fails, so a reviewer sees exactly which
 *      code lost its decision.
 *
 *   3. When a sixth code IS added, the failure message tells the
 *      contributor what to do:
 *        - If it operationally needs its own audit action (like
 *          content_blocked): add the constant to AUDIT_ACTIONS.ai.*, add
 *          a branch at ai-generate.worker.ts:371-374, add the mapping
 *          here with reasoning.
 *        - If it falls through to ai.generation_failed (most common):
 *          add the mapping here with the "deliberate fallthrough"
 *          reasoning. NO worker change needed.
 *
 * This captures the real L6-M2 intent (catch silent fall-through), not
 * just a cardinality count.
 */

import type { AiProviderErrorCode } from '@winback/ai';
import { AUDIT_ACTIONS } from '@winback/contracts';
import { describe, expect, it } from 'vitest';

interface MappingDecision {
  /** The AUDIT_ACTIONS constant the worker uses for this code. */
  readonly auditAction: string;
  /**
   * Why this code gets this audit action. A reviewer must be able to read
   * this and understand whether the mapping is still correct — vague
   * reasoning here is a code-smell, not a passing test.
   */
  readonly reasoning: string;
}

/**
 * The authoritative per-code mapping. TypeScript enforces exhaustiveness:
 * adding a value to AiProviderErrorCode without a corresponding entry here
 * is a compile error (tsc -b goes red).
 */
const ERROR_CODE_MAPPING: Record<AiProviderErrorCode, MappingDecision> = {
  content_blocked: {
    auditAction: AUDIT_ACTIONS.ai.content_blocked,
    reasoning:
      'Content-policy refusal is operationally distinct from a generic failure: ' +
      'non-retryable, prompt-design problem, surfaces in policy / abuse dashboards. ' +
      'Worker branches explicitly via `err instanceof AiProviderContentBlockedError`.',
  },
  rate_limit: {
    auditAction: AUDIT_ACTIONS.ai.generation_failed,
    reasoning:
      'Retryable transient — BullMQ re-queues with backoff. If the error reaches ' +
      'the audit-write path it is post-retry-exhaustion; operationally equivalent ' +
      'to a generic generation_failed. Deliberate fallthrough.',
  },
  transient: {
    auditAction: AUDIT_ACTIONS.ai.generation_failed,
    reasoning:
      'Retryable network/5xx/timeout — same logic as rate_limit. Post-exhaustion ' +
      'fallthrough to generation_failed. Deliberate fallthrough.',
  },
  auth: {
    auditAction: AUDIT_ACTIONS.ai.generation_failed,
    reasoning:
      'Non-retryable provider-API-key issue. Operator-visible via the lastError ' +
      'code on AiGeneration; a separate audit action would not change the response ' +
      'shape, only duplicate the signal. Deliberate fallthrough.',
  },
  invalid_request: {
    auditAction: AUDIT_ACTIONS.ai.generation_failed,
    reasoning:
      'Non-retryable malformed request (prompt-construction bug or model-string ' +
      'mismatch). Same operator-visibility argument as auth. Deliberate fallthrough.',
  },
};

describe('AiProviderErrorCode -> audit-action mapping (closes L6-M2)', () => {
  it('every AiProviderErrorCode value has a documented audit-action mapping', () => {
    // The Record<AiProviderErrorCode, ...> type above is the compile-time
    // gate. This runtime check is audit-readable insurance: a reviewer
    // skimming the test output sees the current mapping count clearly.
    //
    // If this number changes, AiProviderErrorCode gained or lost a value.
    // Decide whether the new code needs its own audit action or falls
    // through to ai.generation_failed, then update ERROR_CODE_MAPPING above
    // (and the worker at apps/drainer/src/workers/ai-generate.worker.ts:371-374
    // ONLY if a new dedicated audit action is needed).
    const codes = Object.keys(ERROR_CODE_MAPPING);
    expect(
      codes.length,
      `AiProviderErrorCode value count changed from 5. New codes detected: see ERROR_CODE_MAPPING. ` +
        `Decide each new code's mapping: dedicated audit action (worker branch + new AUDIT_ACTIONS.ai.* constant) ` +
        `OR deliberate fallthrough to ai.generation_failed (no worker change, just documentation here).`,
    ).toBe(5);
  });

  it('exactly one code (content_blocked) maps to ai.content_blocked', () => {
    // Catches a drift where a contributor adds a second code mapped to
    // ai.content_blocked without updating the worker branch (which currently
    // ONLY fires on `err instanceof AiProviderContentBlockedError`).
    const blockedCodes = Object.entries(ERROR_CODE_MAPPING)
      .filter(([, m]) => m.auditAction === AUDIT_ACTIONS.ai.content_blocked)
      .map(([code]) => code)
      .sort();
    expect(
      blockedCodes,
      `Multiple codes mapped to AUDIT_ACTIONS.ai.content_blocked: ${blockedCodes.join(', ')}. ` +
        `The worker at apps/drainer/src/workers/ai-generate.worker.ts:371-374 only fires ` +
        `ai.content_blocked when 'err instanceof AiProviderContentBlockedError'. Any other code ` +
        `mapped to ai.content_blocked here is documentation drift — the worker would not actually ` +
        `emit it. Either add an instanceof branch OR move the mapping to ai.generation_failed.`,
    ).toEqual(['content_blocked']);
  });

  it('all non-content_blocked codes deliberately fall through to ai.generation_failed', () => {
    const drifters: { code: string; auditAction: string }[] = [];
    for (const [code, decision] of Object.entries(ERROR_CODE_MAPPING)) {
      if (code === 'content_blocked') continue;
      if (decision.auditAction !== AUDIT_ACTIONS.ai.generation_failed) {
        drifters.push({ code, auditAction: decision.auditAction });
      }
    }
    expect(
      drifters,
      `Codes mapped to an audit action OTHER than ai.generation_failed (and NOT content_blocked): ${JSON.stringify(drifters)}. ` +
        `Either the worker's binary classifier needs a new instanceof branch for the dedicated action, ` +
        `or this mapping table is drifted from the worker. Fix one or the other.`,
    ).toEqual([]);
  });

  it('every documented reasoning is non-trivial (no placeholder TODOs)', () => {
    const lazy: string[] = [];
    for (const [code, decision] of Object.entries(ERROR_CODE_MAPPING)) {
      const r = decision.reasoning.trim().toLowerCase();
      if (
        r.length < 40 ||
        r.includes('todo') ||
        r.includes('fixme') ||
        r === 'fallthrough.'
      ) {
        lazy.push(code);
      }
    }
    expect(
      lazy,
      `Codes with placeholder/lazy reasoning: ${lazy.join(', ')}. ` +
        `The reasoning field is the audit-readable justification for each mapping decision. ` +
        `If a reviewer can't tell from the reasoning whether the mapping is still correct, ` +
        `the test isn't doing its job.`,
    ).toEqual([]);
  });
});
