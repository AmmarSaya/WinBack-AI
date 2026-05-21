import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';

import {
  AiProviderAuthError,
  AiProviderContentBlockedError,
  AiProviderError,
  AiProviderInvalidRequestError,
  AiProviderRateLimitError,
  AiProviderTransientError,
} from '../../src/providers/interface.js';
import { OpenAiProvider, mapOpenAiError } from '../../src/providers/openai.js';

/**
 * Synthesises an OpenAI ChatCompletion response with the given content,
 * finish_reason, and usage. Lets each test build the SDK-shape it needs
 * without depending on a fixture library.
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
    model: 'gpt-4.1-mini',
    choices,
  };
  if (opts.omitUsage === true) {
    return base as unknown as OpenAI.Chat.Completions.ChatCompletion;
  }
  return {
    ...base,
    usage: {
      prompt_tokens: opts.inputTokens ?? 50,
      completion_tokens: opts.outputTokens ?? 25,
      total_tokens: opts.totalTokens ?? 75,
    },
  } as OpenAI.Chat.Completions.ChatCompletion;
}

function makeProvider(impl: (args: unknown) => Promise<unknown> | unknown): OpenAiProvider {
  const client = {
    chat: { completions: { create: vi.fn(impl) } },
  } as unknown as OpenAI;
  return new OpenAiProvider(client);
}

describe('OpenAiProvider.generate — happy path', () => {
  it('returns AiGenerateResult with all token fields populated', async () => {
    const provider = makeProvider(async () =>
      fakeChatCompletion({
        content: 'Winback message from gpt-4.1-mini.',
        inputTokens: 120,
        outputTokens: 40,
        totalTokens: 160,
      }),
    );
    const result = await provider.generate({
      model: 'gpt-4.1-mini',
      systemPrompt: 'sys',
      userPrompt: 'user',
      maxTokens: 300,
      temperature: 0.7,
    });
    expect(result.content).toBe('Winback message from gpt-4.1-mini.');
    expect(result.inputTokens).toBe(120);
    expect(result.outputTokens).toBe(40);
    expect(result.totalTokens).toBe(160);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('OpenAiProvider.generate — content-block detection (L4)', () => {
  it('finish_reason=content_filter → AiProviderContentBlockedError (non-retryable)', async () => {
    const provider = makeProvider(async () =>
      fakeChatCompletion({ content: '', finishReason: 'content_filter' }),
    );
    await expect(() =>
      provider.generate({
        model: 'gpt-4.1-mini',
        systemPrompt: 's',
        userPrompt: 'u',
        maxTokens: 300,
        temperature: 0.7,
      }),
    ).rejects.toBeInstanceOf(AiProviderContentBlockedError);
  });

  it('empty content with no content_filter → AiProviderTransientError (retryable)', async () => {
    const provider = makeProvider(async () => fakeChatCompletion({ content: '' }));
    await expect(() =>
      provider.generate({
        model: 'gpt-4.1-mini',
        systemPrompt: 's',
        userPrompt: 'u',
        maxTokens: 300,
        temperature: 0.7,
      }),
    ).rejects.toBeInstanceOf(AiProviderTransientError);
  });

  it('null content → AiProviderTransientError', async () => {
    const provider = makeProvider(async () => fakeChatCompletion({ content: null }));
    await expect(() =>
      provider.generate({
        model: 'gpt-4.1-mini',
        systemPrompt: 's',
        userPrompt: 'u',
        maxTokens: 300,
        temperature: 0.7,
      }),
    ).rejects.toBeInstanceOf(AiProviderTransientError);
  });

  it('no choices at all → AiProviderContentBlockedError', async () => {
    const provider = makeProvider(async () =>
      fakeChatCompletion({ content: '', omitChoice: true }),
    );
    await expect(() =>
      provider.generate({
        model: 'gpt-4.1-mini',
        systemPrompt: 's',
        userPrompt: 'u',
        maxTokens: 300,
        temperature: 0.7,
      }),
    ).rejects.toBeInstanceOf(AiProviderContentBlockedError);
  });

  it('missing usage block → AiProviderTransientError', async () => {
    const provider = makeProvider(async () =>
      fakeChatCompletion({ content: 'fine', omitUsage: true }),
    );
    await expect(() =>
      provider.generate({
        model: 'gpt-4.1-mini',
        systemPrompt: 's',
        userPrompt: 'u',
        maxTokens: 300,
        temperature: 0.7,
      }),
    ).rejects.toBeInstanceOf(AiProviderTransientError);
  });
});

describe('OpenAiProvider.generate — SDK error mapping (L3)', () => {
  function provider(err: unknown): OpenAiProvider {
    return makeProvider(() => {
      throw err;
    });
  }

  it('401 APIError → AiProviderAuthError, non-retryable', async () => {
    const err = new OpenAI.APIError(401, { type: 'auth' }, 'invalid api key', undefined);
    try {
      await provider(err).generate({
        model: 'gpt-4.1-mini',
        systemPrompt: 's',
        userPrompt: 'u',
        maxTokens: 300,
        temperature: 0.7,
      });
      throw new Error('expected throw');
    } catch (caught) {
      expect(caught).toBeInstanceOf(AiProviderAuthError);
      expect((caught as AiProviderError).code).toBe('auth');
      expect((caught as AiProviderError).retryable).toBe(false);
    }
  });

  it('429 APIError → AiProviderRateLimitError, retryable', async () => {
    const err = new OpenAI.APIError(429, { type: 'rate_limit' }, 'too many requests', undefined);
    try {
      await provider(err).generate({
        model: 'gpt-4.1-mini',
        systemPrompt: 's',
        userPrompt: 'u',
        maxTokens: 300,
        temperature: 0.7,
      });
      throw new Error('expected throw');
    } catch (caught) {
      expect(caught).toBeInstanceOf(AiProviderRateLimitError);
      expect((caught as AiProviderError).retryable).toBe(true);
    }
  });

  it('400 APIError with content-policy code → AiProviderContentBlockedError', async () => {
    // Realistic OpenAI content-policy refusal shape — the SDK exposes the
    // policy code via `err.error.code` AND the composed message text.
    const err = new OpenAI.APIError(
      400,
      {
        type: 'invalid_request_error',
        code: 'content_policy_violation',
        message: 'The request was rejected by content policy.',
      },
      'content_policy_violation',
      undefined,
    );
    try {
      await provider(err).generate({
        model: 'gpt-4.1-mini',
        systemPrompt: 's',
        userPrompt: 'u',
        maxTokens: 300,
        temperature: 0.7,
      });
      throw new Error('expected throw');
    } catch (caught) {
      expect(caught).toBeInstanceOf(AiProviderContentBlockedError);
      expect((caught as AiProviderError).retryable).toBe(false);
    }
  });

  it('400 APIError without content-policy text → AiProviderInvalidRequestError', async () => {
    const err = new OpenAI.APIError(400, { type: 'invalid_request' }, 'bad max_tokens', undefined);
    try {
      await provider(err).generate({
        model: 'gpt-4.1-mini',
        systemPrompt: 's',
        userPrompt: 'u',
        maxTokens: 300,
        temperature: 0.7,
      });
      throw new Error('expected throw');
    } catch (caught) {
      expect(caught).toBeInstanceOf(AiProviderInvalidRequestError);
      expect((caught as AiProviderError).retryable).toBe(false);
    }
  });

  it('500 APIError → AiProviderTransientError, retryable', async () => {
    const err = new OpenAI.APIError(503, { type: 'server' }, 'service unavailable', undefined);
    try {
      await provider(err).generate({
        model: 'gpt-4.1-mini',
        systemPrompt: 's',
        userPrompt: 'u',
        maxTokens: 300,
        temperature: 0.7,
      });
      throw new Error('expected throw');
    } catch (caught) {
      expect(caught).toBeInstanceOf(AiProviderTransientError);
      expect((caught as AiProviderError).retryable).toBe(true);
    }
  });

  it('non-SDK Error → AiProviderInvalidRequestError', async () => {
    try {
      await provider(new Error('something else broke')).generate({
        model: 'gpt-4.1-mini',
        systemPrompt: 's',
        userPrompt: 'u',
        maxTokens: 300,
        temperature: 0.7,
      });
      throw new Error('expected throw');
    } catch (caught) {
      expect(caught).toBeInstanceOf(AiProviderInvalidRequestError);
    }
  });
});

describe('mapOpenAiError — direct mapper unit tests', () => {
  it('preserves the original error via `cause`', () => {
    const original = new OpenAI.APIError(429, { type: 'rate_limit' }, 'too many', undefined);
    const mapped = mapOpenAiError(original);
    expect(mapped).toBeInstanceOf(AiProviderRateLimitError);
    expect((mapped as AiProviderError).cause).toBe(original);
  });
});
