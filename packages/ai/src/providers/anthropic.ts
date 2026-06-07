import Anthropic from '@anthropic-ai/sdk';

import {
  AiProviderAuthError,
  AiProviderContentBlockedError,
  AiProviderInvalidRequestError,
  AiProviderRateLimitError,
  AiProviderTransientError,
  type AiGenerateArgs,
  type AiGenerateResult,
  type AiProvider,
} from './interface.js';

/**
 * Anthropic provider — `claude-opus-4-7`, `claude-sonnet-4-6`,
 * `claude-haiku-4-5`.
 *
 * Uses the official `@anthropic-ai/sdk` package. Throws typed errors; does
 * NOT retry.
 *
 * Content-block detection (L4): Anthropic's Messages API can return 200 OK
 * with `stop_reason === 'refusal'` OR an empty `content` array on a
 * content-policy block. The SDK does NOT throw in that case. The provider
 * MUST inspect the response shape and throw `AiProviderContentBlockedError`
 * to keep the BullMQ classifier consistent.
 *
 * Constructor takes an `Anthropic` client for test injection.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic' as const;

  constructor(private readonly client: Anthropic) {}

  async generate(args: AiGenerateArgs): Promise<AiGenerateResult> {
    const startedAt = Date.now();
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: args.model,
        max_tokens: args.maxTokens,
        temperature: args.temperature,
        system: args.systemPrompt,
        messages: [{ role: 'user', content: args.userPrompt }],
      });
    } catch (err) {
      throw mapAnthropicError(err);
    }
    const latencyMs = Date.now() - startedAt;

    // Content-block detection — inspect response shape, NOT just thrown errors.
    // Anthropic returns 200 with stop_reason='refusal' on a policy block.
    if (response.stop_reason === 'refusal') {
      throw new AiProviderContentBlockedError(
        'Anthropic refused to respond (stop_reason=refusal).',
        response,
      );
    }
    if (response.content.length === 0) {
      throw new AiProviderContentBlockedError(
        'Anthropic returned an empty content array; treating as content block.',
        response,
      );
    }

    // Non-text first block on a text-only prompt (no tool definitions, no
    // image input) is a structured refusal — the model is declining via a
    // tool_use / image / other block instead of replying explicitly. Same
    // retry-futility reasoning as `deepseek.ts` empty-content handling:
    // retrying produces the same structured non-response. ContentBlocked,
    // not InvalidRequest.
    const firstBlock = response.content[0];
    if (firstBlock?.type !== 'text') {
      throw new AiProviderContentBlockedError(
        `Anthropic returned non-text content block (type=${firstBlock?.type ?? 'undefined'}); treating as content block.`,
        response,
      );
    }
    // Empty text block with no explicit refusal signal is Anthropic's
    // silent-moderation surface — the model "wrote nothing" rather than
    // refusing outright. Retrying produces the same empty response;
    // BullMQ should NOT burn retry budget on it. Mirrors `deepseek.ts`
    // (DeepSeek has the same silent-moderation behaviour) so the two
    // providers agree on the classification of post-200 empty content.
    const content = firstBlock.text;
    if (content.trim() === '') {
      throw new AiProviderContentBlockedError(
        'Anthropic returned an empty text block; treating as silent content block.',
        response,
      );
    }

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;

    return {
      content,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      latencyMs,
    };
  }
}

/**
 * Constructs a production `AnthropicProvider` against the real SDK.
 */
export function createAnthropicProvider(config: {
  readonly apiKey: string;
}): AnthropicProvider {
  const client = new Anthropic({ apiKey: config.apiKey });
  return new AnthropicProvider(client);
}

/**
 * SDK-error mapper. Per L3, Anthropic has its OWN mapper — distinct error
 * class hierarchy from OpenAI, distinct status-to-class mapping at the edges.
 *
 * Status routing:
 *   - 401                  → AiProviderAuthError       (non-retryable)
 *   - 429                  → AiProviderRateLimitError  (retryable)
 *   - 400                  → AiProviderInvalidRequestError (or ContentBlocked
 *                            if the message hints at policy)
 *   - 5xx / overloaded     → AiProviderTransientError  (retryable)
 *   - connection errors    → AiProviderTransientError  (retryable)
 */
export function mapAnthropicError(err: unknown): Error {
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const message = err.message;
    if (status === 401 || status === 403) {
      return new AiProviderAuthError(`Anthropic auth failed (${status}): ${message}`, err);
    }
    if (status === 429) {
      return new AiProviderRateLimitError(`Anthropic rate limit (${status}): ${message}`, err);
    }
    if (status === 400) {
      // Anthropic's error envelope is `{ type: 'error', error: { type, message } }`.
      // The SDK exposes the inner error on `err.error.error` and the inner
      // message text via `err.message`. Check both — SDK message composition
      // varies enough across versions that a single-source check is fragile.
      //
      // OPERATOR NOTE: this regex matching against Anthropic's natural-language
      // error wording is the SOFT classification surface. If Anthropic changes
      // their 400 message phrasing in any future SDK release, the regex
      // silently degrades — affected 400 responses fall through to
      // `AiProviderInvalidRequestError` (also non-retryable, so BullMQ retry
      // behaviour is unchanged) and only the `code` discriminant stored on
      // `AiGeneration.lastError` differs. Re-check the error-distribution
      // dashboard quarterly; if the `invalid_request` vs `content_blocked`
      // ratio shifts significantly, audit Anthropic's current 400 wording
      // and refresh the patterns below.
      const errAsAny = err as unknown as {
        readonly error?:
          | {
              readonly error?: { readonly type?: string | null; readonly message?: string | null } | null;
            }
          | null;
      };
      const innerType = errAsAny.error?.error?.type ?? '';
      const innerMsg = errAsAny.error?.error?.message ?? '';
      const policyHit =
        /content[_ ]?policy|policy[_ ]?violation|refusal/i.test(message) ||
        /content[_ ]?policy|policy[_ ]?violation|refusal/i.test(innerType) ||
        /content[_ ]?policy|policy[_ ]?violation|refusal/i.test(innerMsg);
      if (policyHit) {
        return new AiProviderContentBlockedError(
          `Anthropic content-policy block: ${message}`,
          err,
        );
      }
      return new AiProviderInvalidRequestError(
        `Anthropic invalid request (${status}): ${message}`,
        err,
      );
    }
    // 529 'overloaded_error' is Anthropic-specific; 500/502/503/504 standard.
    if (status !== undefined && status >= 500 && status < 600) {
      return new AiProviderTransientError(
        `Anthropic server error (${status}): ${message}`,
        err,
      );
    }
    return new AiProviderInvalidRequestError(
      `Anthropic unmapped error (${status ?? 'no-status'}): ${message}`,
      err,
    );
  }
  if (
    err instanceof Anthropic.APIConnectionError ||
    err instanceof Anthropic.APIConnectionTimeoutError
  ) {
    return new AiProviderTransientError(`Anthropic transport error: ${String(err)}`, err);
  }
  return new AiProviderInvalidRequestError(
    `Anthropic unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    err,
  );
}
