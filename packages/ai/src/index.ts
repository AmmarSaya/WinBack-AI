/**
 * Public exports for `@winback/ai` (Epic F).
 *
 * Locked decisions:
 *   - L10: SDK error classes (OpenAI.APIError, Anthropic.APIError, etc.)
 *          are NOT re-exported. Callers see only the typed
 *          `AiProviderError` subclasses. Re-exporting SDK types would
 *          create coupling between caller code and the specific SDK
 *          versions pinned in root `pnpm.overrides`.
 *   - F-1 / F-7 / F-10 / F-11: provider abstraction, prompt construction,
 *          cost rates, and env config are the four surfaces this package
 *          ships. The AI Worker (batch 4) is the only consumer.
 */

// Provider abstraction + 5 typed errors.
export {
  type AiGenerateArgs,
  type AiGenerateResult,
  type AiProvider,
  type AiProviderErrorCode,
  type AiProviderName,
  AiProviderAuthError,
  AiProviderContentBlockedError,
  AiProviderError,
  AiProviderInvalidRequestError,
  AiProviderRateLimitError,
  AiProviderTransientError,
} from './providers/interface.js';

// Concrete providers + factories (the AI Worker constructs via
// `selectActiveProvider`, but factories are exported for integration tests
// that bypass the env-driven selector).
export { OpenAiProvider, createOpenAiProvider } from './providers/openai.js';
export {
  AnthropicProvider,
  createAnthropicProvider,
} from './providers/anthropic.js';
export {
  DeepSeekProvider,
  createDeepSeekProvider,
} from './providers/deepseek.js';

// Active-provider selector. Lazy + memoised.
export { selectActiveProvider } from './providers/index.js';

// Env config. Throws ConfigError synchronously at boot on misconfiguration.
export {
  type AiConfig,
  type GetAiConfigOptions,
  ANTHROPIC_MODELS,
  DEEPSEEK_MODELS,
  OPENAI_MODELS,
  getAiConfig,
} from './config.js';

// Cost-rate table + estimator. BigInt MICROCENTS throughout.
export {
  type ModelCostRate,
  DEPRECATED_MODELS,
  PROVIDER_COST_RATES,
  estimateCostMicrocents,
} from './cost-rates.js';

// Pure prompt builder + V9-aware types.
export {
  type RecentProduct,
  type WinbackDiscount,
  type WinbackPreviousState,
  type WinbackPromptArgs,
  type WinbackPromptCustomer,
  type WinbackPromptMerchant,
  type WinbackPromptResult,
  type WinbackTriggerState,
  buildWinbackPrompt,
} from './prompt-builder.js';
export {
  DISCOUNT_CODE_TOKEN,
  DISCOUNT_VALUE_PERCENT_TOKEN,
  substituteDiscountTokens,
  type DiscountSubstitution,
  type SubstituteResult,
} from './discount-substitutor.js';
