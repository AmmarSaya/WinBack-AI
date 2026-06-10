import { aiToneSchema, type AiTone } from '@winback/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildWinbackPrompt,
  type WinbackPromptArgs,
} from '../src/prompt-builder.js';

const formalTone: AiTone = aiToneSchema.parse({
  style: 'formal',
  avoid: ['cheap', 'gimmick'],
  emphasize: ['quality', 'craftsmanship'],
  emojiPolicy: 'none',
  brandVoiceSample: 'Welcome back. Our pieces are made to last.',
  customInstructions: 'Sign off with "Warmly, the team."',
});

const casualTone: AiTone = aiToneSchema.parse({
  style: 'casual',
  avoid: [],
  emphasize: [],
  emojiPolicy: 'liberal',
});

function baseArgs(): WinbackPromptArgs {
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
    merchant: {
      name: 'Coast Co.',
      shopCurrency: 'USD',
      aiTone: casualTone,
    },
    recentProducts: [{ title: 'Linen Tee' }, { title: 'Cotton Shorts' }],
    discount: null,
  };
}

describe('buildWinbackPrompt — discount placeholder tokens (Lock V9)', () => {
  it('discount === null omits the entire discount-context section', () => {
    const { systemPrompt, userPrompt } = buildWinbackPrompt(baseArgs());
    expect(systemPrompt).not.toContain('{{DISCOUNT_CODE}}');
    expect(systemPrompt).not.toContain('{{DISCOUNT_VALUE_PERCENT}}');
    expect(systemPrompt).not.toContain('Discount instructions');
    expect(userPrompt).not.toContain('{{DISCOUNT_CODE}}');
    expect(userPrompt).not.toContain('{{DISCOUNT_VALUE_PERCENT}}');
    expect(userPrompt).not.toContain('Discount available');
  });

  it('discount provided → both placeholder tokens in user prompt', () => {
    const { systemPrompt, userPrompt } = buildWinbackPrompt({
      ...baseArgs(),
      discount: { valuePercent: 15 },
    });
    // System prompt includes the V9 instruction set
    expect(systemPrompt).toContain('Discount instructions');
    expect(systemPrompt).toContain('{{DISCOUNT_CODE}}');
    expect(systemPrompt).toContain('{{DISCOUNT_VALUE_PERCENT}}');
    // User prompt embeds the literal placeholder tokens
    expect(userPrompt).toContain('{{DISCOUNT_CODE}}');
    expect(userPrompt).toContain('{{DISCOUNT_VALUE_PERCENT}}');
  });

  it('discount provided → real values are NOT in either prompt (V9 invariant)', () => {
    const code = 'WB-AB12-CD34';
    const percent = 15;
    const { systemPrompt, userPrompt } = buildWinbackPrompt({
      ...baseArgs(),
      discount: { valuePercent: percent },
    });
    expect(systemPrompt).not.toContain(code);
    expect(userPrompt).not.toContain(code);
    // The percent number must not appear as a literal where the V9 token belongs.
    // (The string "15" might appear elsewhere as e.g. day-count; check by scanning
    // the discount-context line specifically.)
    const discountLine = userPrompt.split('\n').find((l) => l.includes('Value:'));
    expect(discountLine).toBeDefined();
    expect(discountLine).not.toMatch(/\b15\b/);
    expect(discountLine).toContain('{{DISCOUNT_VALUE_PERCENT}}');
  });

  it('discount + emojiPolicy=none → tokens still emit cleanly', () => {
    const { userPrompt } = buildWinbackPrompt({
      ...baseArgs(),
      merchant: { ...baseArgs().merchant, aiTone: formalTone },
      discount: { valuePercent: 20 },
    });
    expect(userPrompt).toContain('{{DISCOUNT_CODE}}');
    expect(userPrompt).toContain('{{DISCOUNT_VALUE_PERCENT}}');
  });

  // Lock V9 ordering invariants — the discount instruction must outweigh
  // any merchant-level customInstructions, and the user prompt's LAST line
  // must be the V9 reinforcement. Both rely on the LLM last-position-bias
  // for V9 to survive aggressive prompt paraphrasing.
  it('system prompt: V9 discount block appears AFTER customInstructions', () => {
    const { systemPrompt } = buildWinbackPrompt({
      ...baseArgs(),
      merchant: { ...baseArgs().merchant, aiTone: formalTone },
      discount: { valuePercent: 20 },
    });
    const idxCustom = systemPrompt.indexOf('Additional merchant instructions');
    const idxDiscount = systemPrompt.indexOf('Discount instructions');
    expect(idxCustom).toBeGreaterThanOrEqual(0);
    expect(idxDiscount).toBeGreaterThanOrEqual(0);
    expect(idxDiscount).toBeGreaterThan(idxCustom);
  });

  it('user prompt: last line when discount provided is the V9 reinforcement', () => {
    const { userPrompt } = buildWinbackPrompt({
      ...baseArgs(),
      discount: { valuePercent: 15 },
    });
    const lines = userPrompt
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
    const lastLine = lines[lines.length - 1] ?? '';
    expect(lastLine).toMatch(/Remember: use the literal placeholder tokens/);
    expect(lastLine).toContain('{{DISCOUNT_CODE}}');
    expect(lastLine).toContain('{{DISCOUNT_VALUE_PERCENT}}');
  });

  it('user prompt: no V9 reinforcement when discount is null', () => {
    const { userPrompt } = buildWinbackPrompt(baseArgs());
    expect(userPrompt).not.toMatch(/Remember: use the literal placeholder tokens/);
  });
});

describe('buildWinbackPrompt — tone configuration', () => {
  it('formal tone — style guidance + avoid/emphasize lists + brand voice sample', () => {
    const { systemPrompt } = buildWinbackPrompt({
      ...baseArgs(),
      merchant: { ...baseArgs().merchant, aiTone: formalTone },
    });
    expect(systemPrompt).toMatch(/formal/i);
    expect(systemPrompt).toMatch(/Avoid these words.*cheap, gimmick/);
    expect(systemPrompt).toMatch(/Lean into.*quality, craftsmanship/);
    expect(systemPrompt).toContain('Brand voice sample');
    // Match the fixture text verbatim — the brandVoiceSample is rendered
    // unchanged so the LLM matches the merchant's actual voice.
    expect(systemPrompt).toContain('Our pieces are made to last');
  });

  it('casual tone — playful guidance + liberal emoji policy', () => {
    const { systemPrompt } = buildWinbackPrompt(baseArgs());
    expect(systemPrompt).toMatch(/casual/i);
    expect(systemPrompt).toMatch(/Emoji are welcome/);
  });

  it('aiTone === null — falls back to neutral professional default', () => {
    const { systemPrompt } = buildWinbackPrompt({
      ...baseArgs(),
      merchant: { ...baseArgs().merchant, aiTone: null },
    });
    expect(systemPrompt).toMatch(/professional/i);
    expect(systemPrompt).not.toMatch(/Avoid these words/);
    expect(systemPrompt).not.toMatch(/Brand voice sample/);
  });

  it('emojiPolicy=none → "Do not use any emoji" guidance', () => {
    const { systemPrompt } = buildWinbackPrompt({
      ...baseArgs(),
      merchant: { ...baseArgs().merchant, aiTone: formalTone },
    });
    expect(systemPrompt).toMatch(/Do not use any emoji/);
  });
});

describe('buildWinbackPrompt — customer context', () => {
  it('firstName null → "valued customer" salutation', () => {
    const args = baseArgs();
    const { userPrompt } = buildWinbackPrompt({
      ...args,
      customer: { ...args.customer, firstName: null },
    });
    expect(userPrompt).toContain('Address them as: valued customer');
  });

  it('firstName whitespace-only → "valued customer" salutation', () => {
    const args = baseArgs();
    const { userPrompt } = buildWinbackPrompt({
      ...args,
      customer: { ...args.customer, firstName: '   ' },
    });
    expect(userPrompt).toContain('Address them as: valued customer');
  });

  it('firstName empty string → "valued customer" salutation', () => {
    // Locks the case where the salutation fallback was historically masked
    // by `||` (which treats '' as falsy). After the refactor at
    // prompt-builder.ts to satisfy prefer-nullish-coalescing without
    // breaking behavior, the empty-string case is handled by an explicit
    // `trimmed === ''` check rather than `||`. This test prevents a future
    // `?? 'valued customer'` cleanup from silently reintroducing the bug
    // (which would produce "Hi , we miss you!" for empty-string firstName).
    const args = baseArgs();
    const { userPrompt } = buildWinbackPrompt({
      ...args,
      customer: { ...args.customer, firstName: '' },
    });
    expect(userPrompt).toContain('Address them as: valued customer');
  });

  it('mCents in BigInt formatted as currency dollars', () => {
    const args = baseArgs();
    const { userPrompt } = buildWinbackPrompt({
      ...args,
      customer: { ...args.customer, mCents: 199_99n, currency: 'EUR' },
    });
    expect(userPrompt).toContain('EUR 199.99');
  });

  it('fCount=1 uses singular "order"', () => {
    const args = baseArgs();
    const { userPrompt } = buildWinbackPrompt({
      ...args,
      customer: { ...args.customer, fCount: 1 },
    });
    expect(userPrompt).toMatch(/1 order,/);
  });
});

describe('buildWinbackPrompt — recent products', () => {
  it('empty recentProducts → no "recent purchases" line', () => {
    const { userPrompt } = buildWinbackPrompt({
      ...baseArgs(),
      recentProducts: [],
    });
    expect(userPrompt).not.toContain('Their recent purchases included');
  });

  it('non-empty recentProducts → product titles joined cleanly', () => {
    const { userPrompt } = buildWinbackPrompt(baseArgs());
    expect(userPrompt).toContain('Linen Tee; Cotton Shorts');
  });

  it('caps at the first 3 products even if more are passed', () => {
    const { userPrompt } = buildWinbackPrompt({
      ...baseArgs(),
      recentProducts: [
        { title: 'Alpha' },
        { title: 'Bravo' },
        { title: 'Charlie' },
        { title: 'Foxtrot' }, // 4th — must NOT appear
      ],
    });
    expect(userPrompt).toContain('Alpha; Bravo; Charlie');
    expect(userPrompt).not.toContain('Foxtrot');
  });
});

describe('buildWinbackPrompt — state framing', () => {
  it('at_risk → friendly check-in framing', () => {
    const { systemPrompt } = buildWinbackPrompt(baseArgs());
    expect(systemPrompt).toMatch(/quiet recently|check-in/i);
  });

  it('dormant → warm reminder framing', () => {
    const args = baseArgs();
    const { systemPrompt } = buildWinbackPrompt({
      ...args,
      customer: { ...args.customer, triggerState: 'dormant' },
    });
    expect(systemPrompt).toMatch(/several months|warm reminder/i);
  });

  it('lost → "welcome back" framing', () => {
    const args = baseArgs();
    const { systemPrompt } = buildWinbackPrompt({
      ...args,
      customer: { ...args.customer, triggerState: 'lost' },
    });
    expect(systemPrompt).toMatch(/over a year|welcome[ -]back/i);
  });

  it('max-word constraint differs by state', () => {
    const args = baseArgs();
    const { systemPrompt: atRisk } = buildWinbackPrompt({
      ...args,
      customer: { ...args.customer, triggerState: 'at_risk' },
    });
    const { systemPrompt: lost } = buildWinbackPrompt({
      ...args,
      customer: { ...args.customer, triggerState: 'lost' },
    });
    expect(atRisk).toMatch(/Maximum length: 80 words/);
    expect(lost).toMatch(/Maximum length: 120 words/);
  });
});

describe('buildWinbackPrompt — hard constraints in system prompt', () => {
  it('system prompt always includes the no-invention + no-claims constraints', () => {
    const { systemPrompt } = buildWinbackPrompt(baseArgs());
    expect(systemPrompt).toMatch(/Never invent facts/);
    expect(systemPrompt).toMatch(/Never use fake urgency/);
    expect(systemPrompt).toMatch(/Never make medical|financial|legal|health claims/);
    expect(systemPrompt).toMatch(/Never mention competitors/);
  });
});
