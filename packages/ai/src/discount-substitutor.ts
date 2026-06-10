/**
 * Discount-token substitutor (Lock V9 / POST-EPIC-F §4 batch 4.1).
 *
 * The deterministic post-processor half of V9. The prompt builder
 * (`prompt-builder.ts`) instructs the LLM to emit the literal placeholder
 * tokens `{{DISCOUNT_CODE}}` and `{{DISCOUNT_VALUE_PERCENT}}` and NEVER real
 * values. After the LLM responds, the AI Worker calls this module to replace
 * those tokens with the real discount values (created deterministically, not
 * by the model). This closes the AI-hallucinated-discount failure class
 * STRUCTURALLY: the model is never handed a usable code, so it cannot
 * fabricate one that ships.
 *
 * PURE module — no I/O, no logging. The V9 fail-safe (a discount was offered
 * but the LLM omitted a token) is surfaced as `missingTokens` for the CALLER
 * (the worker) to log; keeping the module pure makes it trivially testable
 * and keeps the logging decision at the call site.
 *
 * Token ownership: the canonical token strings live HERE and are the single
 * source of truth. `prompt-builder.test.ts` / `discount-substitutor.test.ts`
 * cross-check that `buildWinbackPrompt`'s emitted output contains exactly
 * these constants, so the emit-side and substitute-side cannot drift (a drift
 * would silently break V9 — the prompt would emit a token the substitutor
 * never replaces).
 */

/** Canonical placeholder token for the discount code. Single source of truth. */
export const DISCOUNT_CODE_TOKEN = '{{DISCOUNT_CODE}}';

/** Canonical placeholder token for the discount percentage value. */
export const DISCOUNT_VALUE_PERCENT_TOKEN = '{{DISCOUNT_VALUE_PERCENT}}';

/** Real discount values to substitute into the LLM output. */
export interface DiscountSubstitution {
  /** Replaces every `{{DISCOUNT_CODE}}`. */
  readonly code: string;
  /** Replaces every `{{DISCOUNT_VALUE_PERCENT}}` (rendered as the integer). */
  readonly valuePercent: number;
}

export interface SubstituteResult {
  /** The text with all present tokens replaced. */
  readonly text: string;
  /**
   * Tokens that a discount was offered FOR but that were ABSENT from the
   * input text — the V9 fail-safe signal. The LLM ignored the placeholder
   * instruction. Empty array = clean. The caller (worker) logs a warning
   * when this is non-empty; the message still ships with whatever
   * substitution was possible (a missing code token means the message
   * simply has no code — never a hallucinated one).
   */
  readonly missingTokens: readonly string[];
}

/**
 * Replace the V9 discount tokens in `text` with the real values.
 *
 * `discount === null` (no discount offered) → returns the text unchanged
 * with no warnings. The prompt builder omits the discount section entirely
 * when no discount is offered, so tokens should not appear; we do not
 * fabricate or strip anything in that case.
 *
 * `discount` provided → global-replaces both tokens, and reports any token
 * that was expected but missing via `missingTokens`.
 *
 * Uses split/join (not regex) for the global replace so the `{{ }}` braces
 * need no escaping and the replacement is literal.
 */
export function substituteDiscountTokens(
  text: string,
  discount: DiscountSubstitution | null,
): SubstituteResult {
  if (discount === null) {
    return { text, missingTokens: [] };
  }

  const missingTokens: string[] = [];
  if (!text.includes(DISCOUNT_CODE_TOKEN)) missingTokens.push(DISCOUNT_CODE_TOKEN);
  if (!text.includes(DISCOUNT_VALUE_PERCENT_TOKEN)) {
    missingTokens.push(DISCOUNT_VALUE_PERCENT_TOKEN);
  }

  const substituted = text
    .split(DISCOUNT_CODE_TOKEN)
    .join(discount.code)
    .split(DISCOUNT_VALUE_PERCENT_TOKEN)
    .join(String(discount.valuePercent));

  return { text: substituted, missingTokens };
}
