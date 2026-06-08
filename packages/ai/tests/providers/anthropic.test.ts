import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  AnthropicProvider,
  mapAnthropicError,
} from '../../src/providers/anthropic.js';
import {
  AiProviderAuthError,
  AiProviderContentBlockedError,
  type AiProviderError,
  AiProviderInvalidRequestError,
  AiProviderRateLimitError,
  AiProviderTransientError,
} from '../../src/providers/interface.js';

function fakeMessage(opts: {
  textContent?: string | null;
  stopReason?: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'refusal' | 'tool_use' | null;
  emptyContent?: boolean;
  nonText?: boolean;
  inputTokens?: number;
  outputTokens?: number;
}): Anthropic.Message {
  let content: Anthropic.ContentBlock[];
  if (opts.emptyContent === true) {
    content = [];
  } else if (opts.nonText === true) {
    content = [
      {
        type: 'tool_use',
        id: 'toolu_test',
        name: 'fake_tool',
        input: {},
      } as unknown as Anthropic.ContentBlock,
    ];
  } else {
    content = [
      {
        type: 'text',
        text: opts.textContent ?? 'Anthropic generated.',
        citations: null,
      } as unknown as Anthropic.ContentBlock,
    ];
  }
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content,
    stop_reason: opts.stopReason ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: opts.inputTokens ?? 80,
      output_tokens: opts.outputTokens ?? 30,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    } as unknown as Anthropic.Usage,
  } as Anthropic.Message;
}

function makeProvider(impl: (args: unknown) => unknown): AnthropicProvider {
  const client = {
    messages: { create: vi.fn(impl) },
  } as unknown as Anthropic;
  return new AnthropicProvider(client);
}

const baseArgs = {
  model: 'claude-haiku-4-5',
  systemPrompt: 'sys',
  userPrompt: 'usr',
  maxTokens: 300,
  temperature: 0.7,
} as const;

describe('AnthropicProvider.generate — happy path', () => {
  it('returns AiGenerateResult with all token fields populated', async () => {
    const provider = makeProvider(async () =>
      fakeMessage({
        textContent: 'Hello from Haiku 4.5.',
        inputTokens: 100,
        outputTokens: 25,
      }),
    );
    const result = await provider.generate(baseArgs);
    expect(result.content).toBe('Hello from Haiku 4.5.');
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(25);
    expect(result.totalTokens).toBe(125);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('AnthropicProvider.generate — content-block detection (L4)', () => {
  it('stop_reason=refusal → AiProviderContentBlockedError on 200 OK', async () => {
    const provider = makeProvider(async () =>
      fakeMessage({ stopReason: 'refusal', textContent: '' }),
    );
    await expect(() => provider.generate(baseArgs)).rejects.toBeInstanceOf(
      AiProviderContentBlockedError,
    );
  });

  it('empty content array → AiProviderContentBlockedError', async () => {
    const provider = makeProvider(async () => fakeMessage({ emptyContent: true }));
    await expect(() => provider.generate(baseArgs)).rejects.toBeInstanceOf(
      AiProviderContentBlockedError,
    );
  });

  // Non-text first block on a text-only prompt = structured refusal.
  // Retrying produces the same non-response. ContentBlocked (non-retryable),
  // not InvalidRequest. Mirrors deepseek.ts empty-content handling.
  it('non-text content block → AiProviderContentBlockedError', async () => {
    const provider = makeProvider(async () => fakeMessage({ nonText: true }));
    await expect(() => provider.generate(baseArgs)).rejects.toBeInstanceOf(
      AiProviderContentBlockedError,
    );
  });

  // Empty text block with no refusal signal = Anthropic's silent-moderation
  // surface. Retrying produces the same empty response. ContentBlocked, not
  // Transient — same retry-futility reasoning as deepseek.ts.
  it('empty text content with no refusal → AiProviderContentBlockedError', async () => {
    const provider = makeProvider(async () => fakeMessage({ textContent: '' }));
    await expect(() => provider.generate(baseArgs)).rejects.toBeInstanceOf(
      AiProviderContentBlockedError,
    );
  });
});

describe('AnthropicProvider.generate — SDK error mapping (L3)', () => {
  function provider(err: unknown): AnthropicProvider {
    return makeProvider(() => {
      throw err;
    });
  }

  it('401 APIError → AiProviderAuthError, non-retryable', async () => {
    const err = new Anthropic.APIError(
      401,
      { type: 'error', error: { type: 'authentication_error', message: 'invalid api key' } },
      'invalid api key',
      undefined,
    );
    try {
      await provider(err).generate(baseArgs);
      throw new Error('expected throw');
    } catch (caught) {
      expect(caught).toBeInstanceOf(AiProviderAuthError);
      expect((caught as AiProviderError).retryable).toBe(false);
    }
  });

  it('429 APIError → AiProviderRateLimitError, retryable', async () => {
    const err = new Anthropic.APIError(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } },
      'rate limited',
      undefined,
    );
    try {
      await provider(err).generate(baseArgs);
      throw new Error('expected throw');
    } catch (caught) {
      expect(caught).toBeInstanceOf(AiProviderRateLimitError);
      expect((caught as AiProviderError).retryable).toBe(true);
    }
  });

  it('400 APIError with policy text → AiProviderContentBlockedError', async () => {
    const err = new Anthropic.APIError(
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'content_policy violation' } },
      'content_policy violation',
      undefined,
    );
    try {
      await provider(err).generate(baseArgs);
      throw new Error('expected throw');
    } catch (caught) {
      expect(caught).toBeInstanceOf(AiProviderContentBlockedError);
    }
  });

  it('400 APIError without policy text → AiProviderInvalidRequestError', async () => {
    const err = new Anthropic.APIError(
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'bad max_tokens' } },
      'bad max_tokens',
      undefined,
    );
    try {
      await provider(err).generate(baseArgs);
      throw new Error('expected throw');
    } catch (caught) {
      expect(caught).toBeInstanceOf(AiProviderInvalidRequestError);
    }
  });

  it('529 overloaded → AiProviderTransientError, retryable', async () => {
    const err = new Anthropic.APIError(
      529,
      { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } },
      'overloaded',
      undefined,
    );
    try {
      await provider(err).generate(baseArgs);
      throw new Error('expected throw');
    } catch (caught) {
      expect(caught).toBeInstanceOf(AiProviderTransientError);
      expect((caught as AiProviderError).retryable).toBe(true);
    }
  });
});

describe('mapAnthropicError — direct mapper unit tests', () => {
  it('preserves the original error via `cause`', () => {
    const original = new Anthropic.APIError(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'rl' } },
      'rl',
      undefined,
    );
    const mapped = mapAnthropicError(original);
    expect(mapped).toBeInstanceOf(AiProviderRateLimitError);
    expect((mapped as AiProviderError).cause).toBe(original);
  });
});
