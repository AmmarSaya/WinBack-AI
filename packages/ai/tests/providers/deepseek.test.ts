import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';

import {
  DeepSeekProvider,
  mapDeepSeekError,
} from '../../src/providers/deepseek.js';
import {
  AiProviderAuthError,
  AiProviderContentBlockedError,
  type AiProviderError,
  AiProviderInvalidRequestError,
  AiProviderRateLimitError,
  AiProviderTransientError,
} from '../../src/providers/interface.js';

/**
 * DeepSeek uses the OpenAI SDK shape, so the fixture-construction helper
 * mirrors the OpenAI test file. The divergence (L3 reason for the mappers
 * being separate) shows up in:
 *
 *   - Content-block detection — DeepSeek frequently returns empty content
 *     WITHOUT setting finish_reason to content_filter. That case is
 *     surfaced here as content-blocked (NOT transient) so retry budget
 *     isn't burned on a request that will produce the same empty response.
 *   - 400 error handling — DeepSeek does NOT have the same content-policy
 *     marker text patterns OpenAI uses. The mapper does not scan messages
 *     for policy text; 400 is non-retryable invalid_request always.
 */

function fakeChatCompletion(opts: {
  content: string | null;
  finishReason?:
    | 'stop'
    | 'length'
    | 'content_filter'
    | 'tool_calls'
    | 'function_call'
    | null;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  omitUsage?: boolean;
  omitChoice?: boolean;
}): OpenAI.Chat.Completions.ChatCompletion {
  const choices = opts.omitChoice === true ? [] : [
    {
      index: 0,
      message: {
        role: 'assistant' as const,
        content: opts.content,
        refusal: null,
      },
      finish_reason: opts.finishReason ?? 'stop',
      logprobs: null,
    },
  ];
  const base = {
    id: 'cmpl-test',
    object: 'chat.completion' as const,
    created: 0,
    model: 'deepseek-v4-flash',
    choices,
  };
  if (opts.omitUsage === true) {
    return base;
  }
  return {
    ...base,
    usage: {
      prompt_tokens: opts.inputTokens ?? 60,
      completion_tokens: opts.outputTokens ?? 20,
      total_tokens: opts.totalTokens ?? 80,
    },
  };
}

function makeProvider(impl: (args: unknown) => Promise<unknown> | unknown): DeepSeekProvider {
  const client = {
    chat: { completions: { create: vi.fn(impl) } },
  } as unknown as OpenAI;
  return new DeepSeekProvider(client);
}

const baseArgs = {
  model: 'deepseek-v4-flash',
  systemPrompt: 'sys',
  userPrompt: 'usr',
  maxTokens: 300,
  temperature: 0.7,
} as const;

describe('DeepSeekProvider.generate — happy path', () => {
  it('returns AiGenerateResult with all token fields populated', async () => {
    const provider = makeProvider(async () =>
      fakeChatCompletion({
        content: 'Cheap winback from v4-flash.',
        inputTokens: 50,
        outputTokens: 20,
        totalTokens: 70,
      }),
    );
    const result = await provider.generate(baseArgs);
    expect(result.content).toBe('Cheap winback from v4-flash.');
    expect(result.inputTokens).toBe(50);
    expect(result.outputTokens).toBe(20);
    expect(result.totalTokens).toBe(70);
  });
});

describe('DeepSeekProvider.generate — content-block detection diverges from OpenAI', () => {
  it('finish_reason=content_filter → AiProviderContentBlockedError', async () => {
    const provider = makeProvider(async () =>
      fakeChatCompletion({ content: '', finishReason: 'content_filter' }),
    );
    await expect(() => provider.generate(baseArgs)).rejects.toBeInstanceOf(
      AiProviderContentBlockedError,
    );
  });

  // L3 divergence from OpenAI: empty content with stop finish_reason is
  // ContentBlocked on DeepSeek, Transient on OpenAI. DeepSeek silently
  // blocks; OpenAI gives finish_reason=content_filter.
  it('empty content + finish_reason=stop → AiProviderContentBlockedError (non-retryable)', async () => {
    const provider = makeProvider(async () =>
      fakeChatCompletion({ content: '', finishReason: 'stop' }),
    );
    try {
      await provider.generate(baseArgs);
      throw new Error('expected throw');
    } catch (caught) {
      expect(caught).toBeInstanceOf(AiProviderContentBlockedError);
      expect((caught as AiProviderError).retryable).toBe(false);
    }
  });

  it('null content → AiProviderContentBlockedError', async () => {
    const provider = makeProvider(async () => fakeChatCompletion({ content: null }));
    await expect(() => provider.generate(baseArgs)).rejects.toBeInstanceOf(
      AiProviderContentBlockedError,
    );
  });

  it('no choices → AiProviderTransientError', async () => {
    const provider = makeProvider(async () =>
      fakeChatCompletion({ content: '', omitChoice: true }),
    );
    await expect(() => provider.generate(baseArgs)).rejects.toBeInstanceOf(
      AiProviderTransientError,
    );
  });

  it('missing usage block → AiProviderTransientError', async () => {
    const provider = makeProvider(async () =>
      fakeChatCompletion({ content: 'fine', omitUsage: true }),
    );
    await expect(() => provider.generate(baseArgs)).rejects.toBeInstanceOf(
      AiProviderTransientError,
    );
  });
});

describe('DeepSeekProvider.generate — SDK error mapping (L3)', () => {
  function provider(err: unknown): DeepSeekProvider {
    return makeProvider(() => {
      throw err;
    });
  }

  it('401 → AiProviderAuthError', async () => {
    const err = new OpenAI.APIError(401, { type: 'auth' }, 'bad key', undefined);
    try {
      await provider(err).generate(baseArgs);
      throw new Error('expected throw');
    } catch (caught) {
      expect(caught).toBeInstanceOf(AiProviderAuthError);
    }
  });

  it('429 → AiProviderRateLimitError', async () => {
    const err = new OpenAI.APIError(429, { type: 'rate_limit' }, 'rl', undefined);
    try {
      await provider(err).generate(baseArgs);
      throw new Error('expected throw');
    } catch (caught) {
      expect(caught).toBeInstanceOf(AiProviderRateLimitError);
    }
  });

  // L3 divergence: DeepSeek does NOT scan 400 messages for policy markers.
  // Even messages mentioning "content_policy" map to InvalidRequest (not
  // ContentBlocked) because DeepSeek's content blocks surface via empty
  // content, not 400.
  it('400 with content_policy text → AiProviderInvalidRequestError (divergence from OpenAI)', async () => {
    const err = new OpenAI.APIError(
      400,
      { type: 'invalid_request' },
      'request mentioned content_policy',
      undefined,
    );
    try {
      await provider(err).generate(baseArgs);
      throw new Error('expected throw');
    } catch (caught) {
      expect(caught).toBeInstanceOf(AiProviderInvalidRequestError);
    }
  });

  it('503 → AiProviderTransientError', async () => {
    const err = new OpenAI.APIError(503, { type: 'server' }, 'service overloaded', undefined);
    try {
      await provider(err).generate(baseArgs);
      throw new Error('expected throw');
    } catch (caught) {
      expect(caught).toBeInstanceOf(AiProviderTransientError);
    }
  });

  it('non-SDK Error → AiProviderInvalidRequestError', async () => {
    try {
      await provider(new Error('boom')).generate(baseArgs);
      throw new Error('expected throw');
    } catch (caught) {
      expect(caught).toBeInstanceOf(AiProviderInvalidRequestError);
    }
  });
});

describe('mapDeepSeekError — direct mapper unit tests', () => {
  it('preserves the original error via `cause`', () => {
    const original = new OpenAI.APIError(503, { type: 'server' }, 'overloaded', undefined);
    const mapped = mapDeepSeekError(original);
    expect(mapped).toBeInstanceOf(AiProviderTransientError);
    expect((mapped as AiProviderError).cause).toBe(original);
  });
});
