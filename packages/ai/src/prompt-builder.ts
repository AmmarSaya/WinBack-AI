import type { AiTone } from '@winback/contracts';

/**
 * Pure prompt construction for the winback AI generation pipeline (Epic F
 * §F-7 + §F-7.5).
 *
 * No I/O. No DB. No SDK. The function takes already-typed inputs (the
 * caller is responsible for `parseAiTone(merchantSettings.aiTone)` and for
 * collecting customer/product/discount context before invoking) and
 * returns two strings: a system prompt and a user prompt.
 *
 * Lock V9 — discount placeholder tokens (POST-EPIC-F-CONSCIOUS-DECISION.md
 * Section 4): the prompt MUST instruct the LLM to emit
 * `{{DISCOUNT_CODE}}` and `{{DISCOUNT_VALUE_PERCENT}}` tokens rather than
 * literal codes/percentages. A deterministic substitutor (Section 4 batch
 * 4.1, NOT this batch) replaces the tokens with real values from the
 * Shopify-created discount row at send time. This eliminates the
 * AI-hallucinated-discount failure class entirely — the LLM can't
 * hallucinate what it doesn't generate.
 *
 * When `discount === null` (no discount being offered), the prompt omits
 * the entire discount-context section. No stray instructions, no token
 * leakage in the output.
 *
 * Hardcoded templates per Epic F Q8 (hybrid lock). Table-backed
 * `PromptTemplate` deferred to Epic G or later.
 */

/** Customer state band — narrows the prompt's framing. */
export type WinbackTriggerState = 'at_risk' | 'dormant' | 'lost';

export type WinbackPreviousState =
  | 'active'
  | 'warm'
  | 'at_risk'
  | 'dormant'
  | 'lost'
  | 'insufficient_data';

export interface WinbackPromptCustomer {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly rDays: number;
  readonly fCount: number;
  readonly mCents: bigint;
  readonly currency: string;
  readonly triggerState: WinbackTriggerState;
  readonly previousState: WinbackPreviousState;
}

export interface WinbackPromptMerchant {
  readonly name: string | null;
  readonly shopCurrency: string;
  /** Already typed via parseAiTone(unknown). Null when merchant hasn't configured tone. */
  readonly aiTone: AiTone | null;
}

export interface RecentProduct {
  /** Display title — already trimmed by the caller. */
  readonly title: string;
}

/**
 * Discount-context INTENT for the prompt. Lock V9 — the prompt renders only
 * placeholder tokens (`{{DISCOUNT_CODE}}` / `{{DISCOUNT_VALUE_PERCENT}}`),
 * never literal values, so a non-null `discount` here is effectively an
 * INTENT FLAG: it switches the V9 token block on. The real values are NOT
 * carried here.
 *
 * Deliberately NO `code` field (A4 §4.2 / Option B): the discount code does
 * not exist when this prompt is built. The drainer handler constructs the
 * prompt at enqueue time; the AI Worker mints the Shopify discount only AFTER
 * the LLM call succeeds, then substitutes the real code into the response via
 * `substituteDiscountTokens`. Putting a `code` here would be a fiction the
 * prompt never reads. `valuePercent` is retained as documentation of what the
 * `{{DISCOUNT_VALUE_PERCENT}}` token stands for (it is the enqueue-time
 * snapshot the worker also uses for substitution), but it too is rendered
 * only as the token, never as a literal.
 */
export interface WinbackDiscount {
  /**
   * The percentage value the `{{DISCOUNT_VALUE_PERCENT}}` token stands for.
   * Rendered as the token in the prompt (never the literal number); the
   * worker substitutes the real value into the LLM output post-generation.
   */
  readonly valuePercent: number;
}

export interface WinbackPromptArgs {
  readonly customer: WinbackPromptCustomer;
  readonly merchant: WinbackPromptMerchant;
  /** Last ≤3 paid-order product titles. May be empty. */
  readonly recentProducts: readonly RecentProduct[];
  /**
   * Discount being offered to the customer for this winback message, or
   * `null` if no discount is included. When non-null, the rendered user
   * prompt contains the V9 placeholder tokens; when null, the discount
   * context section is omitted entirely.
   */
  readonly discount: WinbackDiscount | null;
}

export interface WinbackPromptResult {
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

/**
 * Maximum message length per state. Used to constrain the LLM and keep
 * generated text suitable for the eventual send channels (SMS short, email
 * room for body copy).
 */
const MAX_WORDS_BY_STATE: Record<WinbackTriggerState, number> = {
  at_risk: 80,
  dormant: 100,
  lost: 120,
};

const STATE_FRAMING: Record<WinbackTriggerState, string> = {
  at_risk:
    "They have been quiet recently but were active not long ago. Frame this as a friendly check-in, not an emergency.",
  dormant:
    "They have not purchased in several months. Frame this as a warm reminder of what they enjoyed, with a concrete next step.",
  lost:
    "They have not purchased in over a year. Frame this as a 'we've changed since you last visited' welcome-back invitation.",
};

const EMOJI_GUIDANCE: Record<NonNullable<AiTone['emojiPolicy']>, string> = {
  none: 'Do not use any emoji.',
  minimal: 'Use at most one tasteful emoji, only if it adds clear meaning.',
  liberal: 'Emoji are welcome where they reinforce tone, but do not overdo it.',
};

const STYLE_GUIDANCE: Record<AiTone['style'], string> = {
  formal: 'Tone: formal, polished. Address the customer with courtesy.',
  professional: 'Tone: professional, clear, direct. No filler.',
  casual: 'Tone: casual, friendly, conversational. Sound like a real person.',
  playful: 'Tone: playful, warm, lightly informal — but always respectful.',
};

/**
 * Builds the (systemPrompt, userPrompt) pair for one winback generation.
 *
 * Pure function. Same inputs → same outputs. Tested by snapshot + by branch
 * (tone variants, null firstName, empty recentProducts, discount null vs
 * provided, emoji policy variants).
 */
export function buildWinbackPrompt(args: WinbackPromptArgs): WinbackPromptResult {
  return {
    systemPrompt: buildSystemPrompt(args),
    userPrompt: buildUserPrompt(args),
  };
}

function buildSystemPrompt(args: WinbackPromptArgs): string {
  const merchantName = args.merchant.name ?? 'the store';
  const tone = args.merchant.aiTone;
  const maxWords = MAX_WORDS_BY_STATE[args.customer.triggerState];

  const lines: string[] = [
    `You are an expert customer-winback copywriter for ${merchantName}, a Shopify-based store.`,
    `Your only job is to write a single short message addressed to a specific lapsed customer to invite them back.`,
    '',
    `State framing: ${STATE_FRAMING[args.customer.triggerState]}`,
    `Maximum length: ${String(maxWords)} words. Be concise. Do not exceed this limit.`,
    '',
    'Hard constraints:',
    '  - Never invent facts about the customer, the merchant, or any product.',
    '  - Never use fake urgency ("act now!", "last chance!" unless the merchant has actually said so).',
    '  - Never make medical, financial, legal, or health claims.',
    '  - Never mention competitors.',
    '  - Output the message text only — no subject line, no markdown, no preamble.',
  ];

  if (tone !== null) {
    lines.push('', STYLE_GUIDANCE[tone.style]);
    lines.push(EMOJI_GUIDANCE[tone.emojiPolicy]);

    if (tone.avoid.length > 0) {
      lines.push(`Avoid these words / phrases entirely: ${tone.avoid.join(', ')}.`);
    }
    if (tone.emphasize.length > 0) {
      lines.push(`Lean into these brand values where natural: ${tone.emphasize.join(', ')}.`);
    }
    if (tone.brandVoiceSample !== undefined && tone.brandVoiceSample.trim() !== '') {
      lines.push('', `Brand voice sample (match this voice):\n${tone.brandVoiceSample}`);
    }
    if (tone.customInstructions !== undefined && tone.customInstructions.trim() !== '') {
      lines.push('', `Additional merchant instructions:\n${tone.customInstructions}`);
    }
  } else {
    // No tone configured. Use a neutral professional default — sensible
    // fallback for merchants who haven't customised yet.
    lines.push('', STYLE_GUIDANCE.professional);
    lines.push(EMOJI_GUIDANCE.minimal);
  }

  // Lock V9 — discount placeholder instruction. Placed LAST in the system
  // prompt deliberately. LLMs commonly weight later instructions more
  // heavily than earlier ones; the merchant's `customInstructions` (which
  // can include directives like "always end with a tagline") could
  // otherwise override the V9 token rules and let the model substitute
  // its own values. The V9 instruction MUST be the last word.
  //
  // When discount is null we omit the entire block — the LLM gets NO
  // discount instruction at all, eliminating any chance of it inventing one.
  if (args.discount !== null) {
    lines.push(
      '',
      'Discount instructions (HIGHEST PRIORITY — overrides everything above):',
      '  - The customer is being offered a one-time discount code.',
      '  - Reference the code by writing EXACTLY this placeholder token: {{DISCOUNT_CODE}}',
      '  - Reference the percentage by writing EXACTLY this placeholder token: {{DISCOUNT_VALUE_PERCENT}}',
      '  - Do NOT invent a discount code. Do NOT write a percentage as a number.',
      '  - Do NOT replace the placeholder tokens with anything else — leave them exactly as shown.',
      '  - Use each placeholder token at most once.',
      '  - The placeholder tokens will be replaced with the real values before the customer sees the message.',
    );
  }

  return lines.join('\n');
}

function buildUserPrompt(args: WinbackPromptArgs): string {
  // Salutation fallback: anything that resolves to "no usable name" — null,
  // empty string, or whitespace-only after trim — becomes 'valued customer'.
  // Explicit two-step form (rather than `firstName?.trim() || 'valued customer'`)
  // because the `||` form is a behavioral trap under a ?? rewrite: ?? only
  // catches null/undefined, so empty/whitespace would fall through and produce
  // "Hi , we miss you!". The explicit empty-check makes the rule-intent honest
  // and removes a `||`-on-string site from the prefer-nullish-coalescing
  // sweep without breaking the behavior. Covered by build-winback-prompt.test.ts
  // (firstName null / '' / whitespace-only / normal cases).
  const trimmedFirstName = args.customer.firstName?.trim() ?? '';
  const salutation = trimmedFirstName === '' ? 'valued customer' : trimmedFirstName;
  const dollars = (Number(args.customer.mCents) / 100).toFixed(2);
  const orderWord = args.customer.fCount === 1 ? 'order' : 'orders';

  const lines: string[] = [
    `Customer context:`,
    `  - Address them as: ${salutation}`,
    `  - State band: ${args.customer.triggerState} (previously: ${args.customer.previousState})`,
    `  - Days since last paid order: ${String(args.customer.rDays)}`,
    `  - Lifetime: ${String(args.customer.fCount)} ${orderWord}, ${args.customer.currency} ${dollars} (trailing 365d).`,
  ];

  if (args.recentProducts.length > 0) {
    const productList = args.recentProducts
      .slice(0, 3)
      .map((p) => p.title)
      .join('; ');
    lines.push(`  - Their recent purchases included: ${productList}.`);
  }

  // Lock V9 — discount context section. Always uses the placeholder tokens
  // rather than the real values, regardless of what `args.discount` contains.
  // The values flow through to AiGeneration storage (Section 4 batch 4.2)
  // but the LLM never sees them.
  if (args.discount !== null) {
    lines.push(
      '',
      'Discount available for this customer:',
      `  - Code: {{DISCOUNT_CODE}}`,
      `  - Value: {{DISCOUNT_VALUE_PERCENT}}% off`,
      '  - Mention both placeholder tokens exactly as shown above. The substitution happens later.',
    );
  }

  lines.push(
    '',
    `Write a winback message appropriate for the ${args.customer.triggerState} state. Output the message text only.`,
  );

  // V9 reinforcement at the user-prompt's last instruction position. The
  // system prompt already specifies the token rules; this one-liner
  // survives any aggressive paraphrasing the model might do of upstream
  // context. Last-position bias works in V9's favour here.
  if (args.discount !== null) {
    lines.push(
      `Remember: use the literal placeholder tokens {{DISCOUNT_CODE}} and {{DISCOUNT_VALUE_PERCENT}} — never substitute them with real values.`,
    );
  }

  return lines.join('\n');
}
