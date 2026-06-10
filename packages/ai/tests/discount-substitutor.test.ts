/**
 * Unit tests for the discount-token substitutor (Lock V9 / §4 batch 4.1).
 *
 * Plus the STRUCTURAL DRIFT LOCK: a test that builds a real prompt via
 * `buildWinbackPrompt` with a discount and asserts the output contains
 * exactly the substitutor's canonical token constants — so the emit-side
 * (prompt builder) and the substitute-side (this module) cannot drift apart
 * (a drift would silently break V9: the prompt would emit a token the
 * substitutor never replaces, shipping a literal `{{DISCOUNT_CODE}}` to a
 * customer).
 */

import { aiToneSchema, type AiTone } from '@winback/contracts';
import { describe, expect, it } from 'vitest';

import {
  DISCOUNT_CODE_TOKEN,
  DISCOUNT_VALUE_PERCENT_TOKEN,
  substituteDiscountTokens,
} from '../src/discount-substitutor.js';
import { buildWinbackPrompt, type WinbackPromptArgs } from '../src/prompt-builder.js';

describe('substituteDiscountTokens', () => {
  it('discount=null → text unchanged, no missing-token warnings', () => {
    const text = 'Hey Alex, we miss you. Come back soon!';
    const result = substituteDiscountTokens(text, null);
    expect(result.text).toBe(text);
    expect(result.missingTokens).toEqual([]);
  });

  it('both tokens present → both substituted (globally, every occurrence)', () => {
    const text =
      'Use {{DISCOUNT_CODE}} for {{DISCOUNT_VALUE_PERCENT}}% off. ' +
      'Again: {{DISCOUNT_CODE}} = {{DISCOUNT_VALUE_PERCENT}}%.';
    const result = substituteDiscountTokens(text, { code: 'WB-AB12-CD34', valuePercent: 15 });
    expect(result.text).toBe('Use WB-AB12-CD34 for 15% off. Again: WB-AB12-CD34 = 15%.');
    expect(result.missingTokens).toEqual([]);
  });

  it('text with NO tokens but a discount provided → unchanged text + BOTH tokens reported missing (V9 fail-safe)', () => {
    const text = 'Hey Alex, we miss you. No code in here.';
    const result = substituteDiscountTokens(text, { code: 'WB-AB12-CD34', valuePercent: 15 });
    expect(result.text).toBe(text); // nothing to replace
    expect(result.missingTokens).toEqual([
      DISCOUNT_CODE_TOKEN,
      DISCOUNT_VALUE_PERCENT_TOKEN,
    ]);
  });

  it('only one token present → the other reported missing; the present one is still substituted', () => {
    const text = 'Your code: {{DISCOUNT_CODE}} (limited time).';
    const result = substituteDiscountTokens(text, { code: 'WB-XYZ-9', valuePercent: 20 });
    expect(result.text).toBe('Your code: WB-XYZ-9 (limited time).');
    expect(result.missingTokens).toEqual([DISCOUNT_VALUE_PERCENT_TOKEN]);
  });

  it('V9: a hallucinated RAW code (not a token) is left UNTOUCHED, and the missing token still fires', () => {
    // The LLM ignored the instruction and wrote a literal code instead of the
    // token. The substitutor only replaces tokens, so the raw code is left as
    // the model wrote it (we do not strip it) — BUT missingTokens signals that
    // the real code never got injected, so the caller logs the V9 violation.
    const text = 'Use code WELCOME20 for a discount!';
    const result = substituteDiscountTokens(text, { code: 'WB-AB12-CD34', valuePercent: 15 });
    expect(result.text).toBe('Use code WELCOME20 for a discount!'); // untouched
    expect(result.text).not.toContain('WB-AB12-CD34'); // the real code never shipped
    expect(result.missingTokens).toEqual([
      DISCOUNT_CODE_TOKEN,
      DISCOUNT_VALUE_PERCENT_TOKEN,
    ]);
  });

  it('valuePercent is rendered as the integer string', () => {
    const result = substituteDiscountTokens('{{DISCOUNT_VALUE_PERCENT}}', {
      code: 'X',
      valuePercent: 25,
    });
    expect(result.text).toBe('25');
  });

  it('canonical token constants are the exact literal strings', () => {
    expect(DISCOUNT_CODE_TOKEN).toBe('{{DISCOUNT_CODE}}');
    expect(DISCOUNT_VALUE_PERCENT_TOKEN).toBe('{{DISCOUNT_VALUE_PERCENT}}');
  });
});

// ===========================================================================
// STRUCTURAL DRIFT LOCK — emit-side (prompt builder) vs substitute-side
// ===========================================================================

describe('V9 emit/substitute coupling — the prompt builder emits exactly the substitutor tokens', () => {
  const casualTone: AiTone = aiToneSchema.parse({
    style: 'casual',
    avoid: [],
    emphasize: [],
    emojiPolicy: 'minimal',
  });

  function argsWithDiscount(): WinbackPromptArgs {
    return {
      customer: {
        firstName: 'Alex',
        lastName: 'Smith',
        rDays: 95,
        fCount: 3,
        mCents: 12_500n,
        currency: 'USD',
        triggerState: 'at_risk',
        previousState: 'warm',
      },
      merchant: { name: 'Coast Co.', shopCurrency: 'USD', aiTone: casualTone },
      recentProducts: [{ title: 'Linen Tee' }],
      // Discount INTENT only — the prompt emits the tokens, never a code.
      // The real code is minted by the worker post-generation (A4 §4.2).
      discount: { valuePercent: 15 },
    };
  }

  it('buildWinbackPrompt output contains the substitutor canonical tokens (drift-proof)', () => {
    const { userPrompt } = buildWinbackPrompt(argsWithDiscount());
    expect(userPrompt).toContain(DISCOUNT_CODE_TOKEN);
    expect(userPrompt).toContain(DISCOUNT_VALUE_PERCENT_TOKEN);
  });

  it('end-to-end: substituting the built prompt output injects the real values + no missing tokens', () => {
    const { userPrompt } = buildWinbackPrompt(argsWithDiscount());
    const result = substituteDiscountTokens(userPrompt, {
      code: 'WB-AB12-CD34',
      valuePercent: 15,
    });
    // The real values are present, the tokens are gone, nothing reported missing.
    expect(result.text).toContain('WB-AB12-CD34');
    expect(result.text).not.toContain(DISCOUNT_CODE_TOKEN);
    expect(result.text).not.toContain(DISCOUNT_VALUE_PERCENT_TOKEN);
    expect(result.missingTokens).toEqual([]);
  });

  it('the real code/value do NOT appear in the LLM-facing prompt (only the tokens do)', () => {
    const { systemPrompt, userPrompt } = buildWinbackPrompt(argsWithDiscount());
    // V9: the model never sees the real code/value.
    expect(userPrompt).not.toContain('WB-AB12-CD34');
    expect(systemPrompt).not.toContain('WB-AB12-CD34');
  });
});
