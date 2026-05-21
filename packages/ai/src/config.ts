import { ConfigError, defineConfig } from '@winback/config';
import { z } from 'zod';

import { DEPRECATED_MODELS } from './cost-rates.js';

/**
 * AI generation pipeline config (Epic F §F-11).
 *
 * Lives in `packages/ai/src/config.ts` — NOT `packages/config`. Provider
 * selection + per-provider API keys are an `@winback/ai` concern; the
 * cross-cutting `@winback/config` package owns only core + Redis vars.
 * (§F-11's earlier phrasing said "added to packages/config" — that line
 * was stale; §F-2's file placement is canonical and matches the established
 * `packages/shopify/src/config.ts` precedent.)
 *
 * Validated lazily on first call, cached as a singleton. Matches the
 * `getShopifyConfig` pattern: boot wires `getAiConfig()` early so a
 * misconfigured process dies at startup rather than at first generation.
 *
 * Locked decisions:
 *   - L5: `z.discriminatedUnion` on `AI_PROVIDER`. Per-provider `AI_MODEL`
 *         enum AND per-provider API-key requirement. Boot fails if
 *         `AI_PROVIDER=openai` but `OPENAI_API_KEY` is empty.
 *   - V7: default provider in `.env.example` + `ci.yml` is `deepseek`
 *         with `AI_MODEL=deepseek-v4-flash`. The unit-economics math
 *         in PRICING-MODEL-v1.md assumes this default. Switching
 *         providers requires a margin re-baseline.
 *   - L6: provider construction is lazy + memoised in `selectActiveProvider`
 *         — `getAiConfig` validates the active provider's key only.
 *         A merchant with `AI_PROVIDER=deepseek` and no `OPENAI_API_KEY`
 *         boots fine.
 *
 * Pre-Zod deprecation check (cost-rates.DEPRECATED_MODELS):
 *   - `deepseek-chat` → deprecated; use `deepseek-v4-flash`.
 *   - `gpt-4o` / `gpt-4o-mini` → grandfathered legacy; use gpt-4.1 family.
 *
 * Producing a friendly `ConfigError` for those cases requires running
 * BEFORE the discriminated-union check (Zod's generic "Invalid enum value"
 * gives operators no guidance).
 */

const baseSchema = z.object({
  AI_MAX_TOKENS: z.coerce
    .number()
    .int('AI_MAX_TOKENS must be an integer')
    .positive('AI_MAX_TOKENS must be positive')
    .max(4096, 'AI_MAX_TOKENS may not exceed 4096 (winback messages are short)')
    .default(300),
  AI_TEMPERATURE: z.coerce
    .number()
    .min(0, 'AI_TEMPERATURE must be >= 0')
    .max(2, 'AI_TEMPERATURE must be <= 2')
    .default(0.7),
});

/**
 * Per-provider model whitelist. Mirrors `PROVIDER_COST_RATES` keys in
 * `cost-rates.ts`. If a model is added to one, it MUST be added to the
 * other — `estimateCostMicrocents` throws on unknown combinations.
 */
const OPENAI_MODELS = ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano'] as const;
const ANTHROPIC_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
] as const;
const DEEPSEEK_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const;

const aiConfigSchema = z.discriminatedUnion('AI_PROVIDER', [
  baseSchema.extend({
    AI_PROVIDER: z.literal('openai'),
    AI_MODEL: z.enum(OPENAI_MODELS),
    OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required when AI_PROVIDER=openai'),
  }),
  baseSchema.extend({
    AI_PROVIDER: z.literal('anthropic'),
    AI_MODEL: z.enum(ANTHROPIC_MODELS),
    ANTHROPIC_API_KEY: z
      .string()
      .min(1, 'ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic'),
  }),
  baseSchema.extend({
    AI_PROVIDER: z.literal('deepseek'),
    AI_MODEL: z.enum(DEEPSEEK_MODELS),
    DEEPSEEK_API_KEY: z
      .string()
      .min(1, 'DEEPSEEK_API_KEY is required when AI_PROVIDER=deepseek'),
  }),
]);

export type AiConfig = z.infer<typeof aiConfigSchema>;

let cached: AiConfig | null = null;

export interface GetAiConfigOptions {
  readonly reset?: boolean;
  readonly source?: NodeJS.ProcessEnv | undefined;
}

/**
 * Reads + validates AI generation config from env. Throws `ConfigError`
 * synchronously on misconfiguration — boot-only, do not catch in normal
 * code paths.
 *
 * Pre-Zod check rejects deprecated model strings with operator-friendly
 * messages. Without it, the discriminated-union's generic "Invalid enum
 * value, expected one of..." message gives no hint that the model is
 * deprecating.
 */
export function getAiConfig(options?: GetAiConfigOptions): AiConfig {
  if (options?.reset === true) cached = null;
  if (cached === null) {
    const source = options?.source ?? process.env;

    // Pre-flight: catch deprecated model strings BEFORE Zod's discriminated
    // union throws a generic enum-mismatch error. Friendlier error message;
    // also catches typo'd legacy strings the operator might paste from old
    // docs or other projects.
    //
    // SCOPING: only surface the deprecation message when the model belongs
    // to the active provider's family. If AI_PROVIDER=anthropic and
    // AI_MODEL=gpt-4o, the friendly "use gpt-4.1-mini" guidance would
    // mislead the operator (gpt-4.1-mini is also invalid for Anthropic) —
    // let the discriminated-union throw its generic "Invalid enum value"
    // so the operator sees the real problem (provider/model mismatch)
    // before the deprecation one.
    const rawProvider = source.AI_PROVIDER;
    const rawModel = source.AI_MODEL;
    if (rawModel !== undefined && DEPRECATED_MODELS.has(rawModel)) {
      const isPlausibleProvider =
        (rawModel.startsWith('gpt-') && rawProvider === 'openai') ||
        (rawModel.startsWith('deepseek-') && rawProvider === 'deepseek') ||
        (rawModel.startsWith('claude-') && rawProvider === 'anthropic');
      if (isPlausibleProvider) {
        const guidance = DEPRECATED_MODELS.get(rawModel) ?? `${rawModel} is deprecated.`;
        throw new ConfigError(`Invalid configuration:\n  - AI_MODEL: ${guidance}\n`, [
          { path: 'AI_MODEL', message: guidance, received: 'present' },
        ]);
      }
    }

    cached = defineConfig(
      aiConfigSchema,
      options?.source !== undefined ? { source: options.source } : {},
    );
  }
  return cached;
}

/** Provider-name + key helpers exported for testing / `selectActiveProvider`. */
export {
  ANTHROPIC_MODELS,
  DEEPSEEK_MODELS,
  OPENAI_MODELS,
};
