import type { AiConfig } from '../config.js';

import { createAnthropicProvider } from './anthropic.js';
import { createDeepSeekProvider } from './deepseek.js';
import type { AiProvider } from './interface.js';
import { createOpenAiProvider } from './openai.js';

/**
 * Lazy provider construction (L6).
 *
 * Only the ACTIVE provider is instantiated. `AI_PROVIDER=deepseek` with no
 * `OPENAI_API_KEY` set must boot cleanly — eager construction of all three
 * would throw on the missing OpenAI key even though OpenAI isn't being used.
 *
 * Memoised by config-reference. A test that calls `getAiConfig({ reset: true })`
 * + this selector twice gets two different providers (different config
 * objects). Production callers hand the same `getAiConfig()` result around
 * for the lifetime of the process, so memoisation matches that lifecycle.
 *
 * NOTE: this function does NOT inspect `cached.config` for deep equality —
 * the assumption is that `getAiConfig()` returns a singleton per-process,
 * so reference equality is sufficient. If a future caller patches config
 * post-boot (e.g. dynamic provider switching), the cache must be reset
 * explicitly.
 */

let cached: { readonly config: AiConfig; readonly provider: AiProvider } | null = null;

export function selectActiveProvider(config: AiConfig): AiProvider {
  if (cached !== null && cached.config === config) {
    return cached.provider;
  }
  const provider = constructForProvider(config);
  cached = { config, provider };
  return provider;
}

function constructForProvider(config: AiConfig): AiProvider {
  // The discriminated-union narrows config.AI_PROVIDER + the corresponding
  // API key field per branch. The exhaustiveness check (`_exhaustive: never`)
  // catches any future provider added to the union without a branch here.
  switch (config.AI_PROVIDER) {
    case 'openai':
      return createOpenAiProvider({ apiKey: config.OPENAI_API_KEY });
    case 'anthropic':
      return createAnthropicProvider({ apiKey: config.ANTHROPIC_API_KEY });
    case 'deepseek':
      return createDeepSeekProvider({ apiKey: config.DEEPSEEK_API_KEY });
    default: {
      const _exhaustive: never = config;
      throw new Error(`Unhandled AI_PROVIDER: ${String((_exhaustive as AiConfig).AI_PROVIDER)}`);
    }
  }
}

/** Reset the memoised provider. Tests use this between scenarios. */
export function _resetProviderCacheForTests(): void {
  cached = null;
}
