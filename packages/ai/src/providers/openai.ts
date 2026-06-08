import OpenAI, { APIError as OpenAIAPIError } from 'openai';

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
 * OpenAI provider — `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`.
 *
 * Uses the official `openai` SDK. Throws typed `AiProviderError` subclasses;
 * does NOT retry. BullMQ (batch 4) owns retry orchestration.
 *
 * Content-block detection (L4): inspects `choices[0].finish_reason` for
 * `'content_filter'`. OpenAI returns 200 OK with this finish reason on
 * a moderation block — the call doesn't throw, the response just doesn't
 * have usable content.
 *
 * Constructor takes a constructed `OpenAI` client so tests can inject a
 * mock. Production callers use `createOpenAiProvider(config)`.
 */
export class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const;

  constructor(private readonly client: OpenAI) {}

  async generate(args: AiGenerateArgs): Promise<AiGenerateResult> {
    const startedAt = Date.now();
    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await this.client.chat.completions.create({
        model: args.model,
        messages: [
          { role: 'system', content: args.systemPrompt },
          { role: 'user', content: args.userPrompt },
        ],
        max_tokens: args.maxTokens,
        temperature: args.temperature,
      });
    } catch (err) {
      throw mapOpenAiError(err);
    }
    const latencyMs = Date.now() - startedAt;

    // Content-block detection: OpenAI returns 200 with finish_reason set.
    const choice = response.choices[0];
    if (choice === undefined || choice.finish_reason === 'content_filter') {
      throw new AiProviderContentBlockedError(
        'OpenAI moderation blocked the response (finish_reason=content_filter).',
        response,
      );
    }

    const content = choice.message.content;
    if (content === null || content === undefined || content.trim() === '') {
      // Empty/null content with no content_filter signal. Treat as transient
      // — typically indicates an intermittent provider issue.
      throw new AiProviderTransientError(
        'OpenAI returned an empty response with no error or content_filter signal.',
        response,
      );
    }

    const usage = response.usage;
    if (usage === undefined) {
      // The SDK guarantees usage on non-streaming calls; if it's missing
      // something is wrong with the response shape. Treat as transient.
      throw new AiProviderTransientError(
        'OpenAI response missing usage block; cannot account for spend.',
        response,
      );
    }

    return {
      content,
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      latencyMs,
    };
  }
}

/**
 * Constructs a production `OpenAiProvider` against the real SDK.
 *
 * `baseURL` override is supported here for parity with the DeepSeek
 * provider's construction path — production OpenAI callers never set it.
 */
export function createOpenAiProvider(config: {
  readonly apiKey: string;
  readonly baseURL?: string;
}): OpenAiProvider {
  const client = new OpenAI({
    apiKey: config.apiKey,
    ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
  });
  return new OpenAiProvider(client);
}

/**
 * SDK-error mapper. Per L3, OpenAI gets its OWN mapper — DeepSeek does not
 * delegate here even though the underlying SDK is the same (DeepSeek's
 * error shape diverges in edge cases).
 *
 * Status-code routing:
 *   - 401 / 403            → AiProviderAuthError       (non-retryable)
 *   - 429                  → AiProviderRateLimitError  (retryable)
 *   - 400                  → AiProviderInvalidRequestError (non-retryable)
 *   - 500–599 / network    → AiProviderTransientError  (retryable)
 *   - anything else        → AiProviderInvalidRequestError + log warning
 *                            (treat as non-retryable so the same broken
 *                             request doesn't burn the retry budget)
 */
export function mapOpenAiError(err: unknown): Error {
  if (err instanceof OpenAIAPIError) {
    // `instanceof GenericClass` widens the SDK's generic type parameters
    // to `any`; cast back to the default-instantiated class so `.status`
    // and `.message` resolve to their declared types (`number | undefined`
    // and `string`). Verified against the OpenAI SDK's `error.d.ts`.
    const e = err as OpenAIAPIError;
    const status = e.status;
    const message = e.message;
    if (status === 401 || status === 403) {
      return new AiProviderAuthError(`OpenAI auth failed (${String(status)}): ${message}`, err);
    }
    if (status === 429) {
      return new AiProviderRateLimitError(`OpenAI rate limit (${String(status)}): ${message}`, err);
    }
    if (status === 400) {
      // OpenAI marks content-policy refusals as 400 with a specific code.
      // The SDK exposes the code on `err.code` (string), the underlying
      // error object on `err.error.code` / `err.error.type`, and the
      // composed message text via `err.message`. Inspect all three —
      // SDK versions vary which fields populate, and a single-source
      // check has been observed to miss policy blocks in practice.
      const errAsAny = err as unknown as {
        readonly code?: string | null;
        readonly error?: { readonly code?: string | null; readonly type?: string | null } | null;
      };
      const codeStr = errAsAny.code ?? errAsAny.error?.code ?? errAsAny.error?.type ?? '';
      const policyHit =
        /content[_ ]?policy|policy[_ ]?violation|content[_ ]?filter/i.test(message) ||
        /content[_ ]?policy|policy[_ ]?violation|content[_ ]?filter/i.test(codeStr);
      if (policyHit) {
        return new AiProviderContentBlockedError(
          `OpenAI content-policy block: ${message}`,
          err,
        );
      }
      return new AiProviderInvalidRequestError(
        `OpenAI invalid request (${String(status)}): ${message}`,
        err,
      );
    }
    if (status !== undefined && status >= 500 && status < 600) {
      return new AiProviderTransientError(
        `OpenAI server error (${String(status)}): ${message}`,
        err,
      );
    }
    // Unmapped APIError status — treat as invalid request (non-retryable)
    // so we don't burn retry budget on a status we don't understand.
    return new AiProviderInvalidRequestError(
      `OpenAI unmapped error (${String(status ?? 'no-status')}): ${message}`,
      err,
    );
  }
  // Connection / DNS / abort — transient by definition.
  if (err instanceof OpenAI.APIConnectionError || err instanceof OpenAI.APIConnectionTimeoutError) {
    return new AiProviderTransientError(`OpenAI transport error: ${String(err)}`, err);
  }
  // Fall through: not an SDK error at all. Most likely a bug in our own
  // request construction. Non-retryable.
  return new AiProviderInvalidRequestError(
    `OpenAI unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    err,
  );
}
