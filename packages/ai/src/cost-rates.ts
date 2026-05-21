/**
 * Per-provider, per-model cost rates (Epic F §F-10).
 *
 * Stored as BigInt MICROCENTS per 1M tokens. 1 USD = 100 cents = 100_000_000
 * microcents. Microcents (not cents) because modern LLM pricing is in
 * fractions of a cent per token — float arithmetic would lose precision
 * on aggregation. BigInt math is used end-to-end; cents only appear when
 * the daily `AiSpendBucket` ceiling check converts the cap.
 *
 * Verified against vendor pricing pages 2026-05-21. Re-verify quarterly
 * (operator runbook: open the three URLs, diff against this file, surface
 * deltas before any merchant-visible pricing decision).
 *
 *   - Anthropic: https://platform.claude.com/docs/en/docs/about-claude/models
 *   - OpenAI:    https://openai.com/api/pricing/  (WebFetch blocked; verified
 *                via multiple secondary sources)
 *   - DeepSeek:  https://api-docs.deepseek.com/quick_start/pricing
 *
 * Excluded by design (do NOT add without explicit approval — each row in
 * this table is a model an operator could plausibly set as `AI_MODEL`,
 * which means a typo in env config could land on it):
 *
 *   - gpt-4o / gpt-4o-mini: grandfathered legacy as of 2026-Q1, replaced
 *     by the gpt-4.1 family. If a future merchant requires gpt-4o, add the
 *     row WITH freshly-verified pricing — do not assume the historical $5/$15
 *     rates still hold (they're now $2.50/$10 grandfathered).
 *   - deepseek-chat: deprecating alias. DeepSeek's docs warn it's going
 *     away. Operators must use deepseek-v4-flash directly; `getAiConfig`
 *     rejects deepseek-chat at boot with a deprecation message.
 *   - GPT-5 family (gpt-5, gpt-5.4, gpt-5.5): overkill for short winback
 *     prompts. Add only when a specific merchant use case requires it.
 *   - Anthropic legacy models (claude-opus-4-6, claude-sonnet-4-5, etc.):
 *     migration target is the 4.6-generation flagship line. Older Claude 4
 *     IDs are still callable but not in our active table.
 *   - Cache-hit DeepSeek pricing ($0.0028/M): we don't get cache hits on
 *     first-touch personalised winback prompts; ignore the discount tier.
 *   - DeepSeek's 75%-off promo on v4-pro (expires 2026-05-31): rate below
 *     uses the FULL post-discount price. Don't bake temporary discounts
 *     into a constant — the table would silently triple itself when the
 *     promo expires.
 */

import type { AiProviderName } from './providers/interface.js';

export interface ModelCostRate {
  /** Microcents charged per 1M input tokens. */
  readonly inputPer1M: bigint;
  /** Microcents charged per 1M output tokens. */
  readonly outputPer1M: bigint;
}

/**
 * Source of truth for cost math. Keys are provider names + model identifier
 * strings — both must match the values that flow through `AI_PROVIDER` and
 * `AI_MODEL` env vars exactly. `getAiConfig` validates `AI_MODEL` against
 * a discriminated-union Zod enum per provider; this table is the second
 * line of defence (`estimateCostMicrocents` throws on unknown combinations).
 */
export const PROVIDER_COST_RATES: Record<
  AiProviderName,
  Record<string, ModelCostRate>
> = {
  openai: {
    // GPT-4.1 family — current generation. Replaces the gpt-4o line.
    'gpt-4.1':      { inputPer1M: 500_000_000n, outputPer1M: 1_500_000_000n }, // $5  / $15
    'gpt-4.1-mini': { inputPer1M:  40_000_000n, outputPer1M:   160_000_000n }, // $0.40 / $1.60
    'gpt-4.1-nano': { inputPer1M:  10_000_000n, outputPer1M:    40_000_000n }, // $0.10 / $0.40
  },
  anthropic: {
    // Claude 4.6-generation. claude-opus-4-7 is the current flagship per
    // Anthropic's "if unsure, start here" recommendation. Aliases match
    // the pinned-snapshot model IDs — they will NOT silently roll forward
    // (Anthropic 4.6+ aliases are explicit pins, not evergreen pointers).
    'claude-opus-4-7':   { inputPer1M: 500_000_000n, outputPer1M: 2_500_000_000n }, // $5  / $25
    'claude-sonnet-4-6': { inputPer1M: 300_000_000n, outputPer1M: 1_500_000_000n }, // $3  / $15
    'claude-haiku-4-5':  { inputPer1M: 100_000_000n, outputPer1M:   500_000_000n }, // $1  / $5
  },
  deepseek: {
    // DeepSeek v4 generation. v4-flash is the recommended high-volume
    // default; v4-pro at full post-discount price for higher-quality
    // generation when the merchant's monthlyAiSpendCapCents allows it.
    'deepseek-v4-flash': { inputPer1M:  14_000_000n, outputPer1M:    28_000_000n }, // $0.14 / $0.28
    'deepseek-v4-pro':   { inputPer1M: 174_000_000n, outputPer1M:   348_000_000n }, // $1.74 / $3.48 (full post-discount)
  },
};

/**
 * Computes the microcent cost of a completed LLM call. BigInt arithmetic
 * end-to-end — no float anywhere near money (locked decision #2).
 *
 * Math: `(tokens * ratePer1M) / 1_000_000n`. Integer division truncates
 * toward zero, which under-states cost by at most 1 microcent per token-
 * bucket — negligible at the ceiling-check granularity and conservative
 * (under-stated cost can never trip the cap one call too late).
 *
 * Throws `Error('Unknown provider/model: ...')` on a combination not in
 * `PROVIDER_COST_RATES`. The caller is `getAiConfig`-validated, so this
 * only fires if the table is out of sync with the config schema — a
 * developer-time bug, not a runtime input error.
 */
export function estimateCostMicrocents(
  provider: AiProviderName,
  model: string,
  inputTokens: number,
  outputTokens: number,
): bigint {
  const providerRates = PROVIDER_COST_RATES[provider];
  if (providerRates === undefined) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  const rates = providerRates[model];
  if (rates === undefined) {
    throw new Error(`Unknown provider/model: ${provider}/${model}`);
  }
  return (
    (BigInt(inputTokens) * rates.inputPer1M) / 1_000_000n +
    (BigInt(outputTokens) * rates.outputPer1M) / 1_000_000n
  );
}

/**
 * Pre-flight rejection list for known-deprecating model strings. Surfaced
 * here (not buried in `getAiConfig`) so any caller that wants a friendlier
 * error before Zod's generic "not in enum" message can opt in.
 *
 * Used by `getAiConfig`'s pre-Zod check. NOT used by `estimateCostMicrocents`
 * (those entries are simply absent from `PROVIDER_COST_RATES`).
 */
export const DEPRECATED_MODELS: ReadonlyMap<string, string> = new Map([
  ['deepseek-chat', 'deepseek-chat is deprecated. Use deepseek-v4-flash directly.'],
  ['gpt-4o', 'gpt-4o is grandfathered legacy. Use gpt-4.1-mini or gpt-4.1 instead.'],
  ['gpt-4o-mini', 'gpt-4o-mini is grandfathered legacy. Use gpt-4.1-nano or gpt-4.1-mini instead.'],
]);
