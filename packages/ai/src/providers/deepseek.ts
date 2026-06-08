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
 * DeepSeek provider — `deepseek-v4-flash`, `deepseek-v4-pro`.
 *
 * DeepSeek exposes an OpenAI-compatible Chat Completions endpoint, so the
 * provider uses the `openai` SDK with a `baseURL` override. The underlying
 * SDK is shared with `OpenAiProvider`, but the error-mapping and content-
 * block detection live HERE and DO NOT delegate to OpenAI's mapper (per L3
 * — DeepSeek's error response shapes diverge in edge cases, and shared
 * mappers are where production bugs hide).
 *
 * Content-block detection (L4): DeepSeek typically returns 200 OK with
 * empty `content` on a moderation block; `finish_reason` is sometimes
 * `'content_filter'` and sometimes `'stop'`. Inspect the content string
 * directly rather than relying on `finish_reason`.
 *
 * The `deepseek-chat` legacy model alias is REJECTED at the config layer
 * (`getAiConfig` pre-Zod check); this provider will only see
 * `deepseek-v4-flash` or `deepseek-v4-pro`.
 *
 * Constructor takes an `OpenAI` client (configured with DeepSeek's
 * `baseURL`) for test injection.
 */
export class DeepSeekProvider implements AiProvider {
  readonly name = 'deepseek' as const;

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
      throw mapDeepSeekError(err);
    }
    const latencyMs = Date.now() - startedAt;

    const choice = response.choices[0];
    if (choice === undefined) {
      throw new AiProviderTransientError(
        'DeepSeek returned no choices in response.',
        response,
      );
    }

    // DeepSeek content-block detection: inspect content directly. The
    // provider has been observed to return 200 with empty content on
    // moderation blocks without setting finish_reason to content_filter
    // — divergence from OpenAI's behaviour (this is the L3 reason the
    // mappers are separate).
    if (choice.finish_reason === 'content_filter') {
      throw new AiProviderContentBlockedError(
        'DeepSeek moderation blocked the response (finish_reason=content_filter).',
        response,
      );
    }

    // SDK declares `ChatCompletionMessage.content: string | null` (verified
    // against node_modules/.pnpm/openai@4.104.0/.../completions.d.ts:653).
    // The previous `content === undefined` clause was dead per the SDK
    // type, and DeepSeek's documented divergence is about empty-STRING
    // content on moderation blocks (covered by `.trim() === ''`), not
    // undefined. Removed (5c-2 audit).
    const content = choice.message.content;
    if (content === null || content.trim() === '') {
      // Empty content from DeepSeek — most commonly a silent moderation
      // block per the divergence above. Surface as content-blocked so it
      // does NOT trigger a retry that will produce the same empty response.
      throw new AiProviderContentBlockedError(
        'DeepSeek returned empty content; treating as silent content block.',
        response,
      );
    }

    const usage = response.usage;
    if (usage === undefined) {
      throw new AiProviderTransientError(
        'DeepSeek response missing usage block; cannot account for spend.',
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
 * Constructs a production `DeepSeekProvider` against the real SDK with
 * DeepSeek's API base URL.
 *
 * The OpenAI SDK has supported `baseURL` override since v4.0.0; pinned at
 * 4.104.0 in root `pnpm.overrides` (verified to keep the override available).
 */
export function createDeepSeekProvider(config: {
  readonly apiKey: string;
}): DeepSeekProvider {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: 'https://api.deepseek.com/v1',
  });
  return new DeepSeekProvider(client);
}

/**
 * SDK-error mapper. PER L3, DeepSeek has its own mapper even though it
 * uses the OpenAI SDK. The two diverge on:
 *
 *   1. DeepSeek occasionally returns 400 with no recognisable error code —
 *      OpenAI's mapper would label this `invalid_request`, but DeepSeek
 *      docs note their 400s are sometimes transient validation glitches.
 *      Erring on the side of non-retryable here (same as OpenAI) is the
 *      safer default; revisit if production data shows retry-recoverable
 *      400s from DeepSeek specifically.
 *   2. DeepSeek's content-block surface is response-shape-only (above), so
 *      this mapper does NOT detect content blocks via error text.
 *   3. DeepSeek uses 503 'service overloaded' more often than OpenAI;
 *      already covered by the standard 5xx → transient mapping.
 *
 * Otherwise the status-to-class mapping mirrors OpenAI's.
 */
export function mapDeepSeekError(err: unknown): Error {
  if (err instanceof OpenAIAPIError) {
    // `instanceof GenericClass` widens the SDK's generic type parameters
    // to `any`; cast back to the default-instantiated class so `.status`
    // and `.message` resolve to their declared types (`number | undefined`
    // and `string`). Verified against the OpenAI SDK's `error.d.ts`.
    const e = err as OpenAIAPIError;
    const status = e.status;
    const message = e.message;
    if (status === 401 || status === 403) {
      return new AiProviderAuthError(`DeepSeek auth failed (${String(status)}): ${message}`, err);
    }
    if (status === 429) {
      return new AiProviderRateLimitError(`DeepSeek rate limit (${String(status)}): ${message}`, err);
    }
    if (status === 400) {
      return new AiProviderInvalidRequestError(
        `DeepSeek invalid request (${String(status)}): ${message}`,
        err,
      );
    }
    if (status !== undefined && status >= 500 && status < 600) {
      return new AiProviderTransientError(
        `DeepSeek server error (${String(status)}): ${message}`,
        err,
      );
    }
    return new AiProviderInvalidRequestError(
      `DeepSeek unmapped error (${String(status ?? 'no-status')}): ${message}`,
      err,
    );
  }
  if (
    err instanceof OpenAI.APIConnectionError ||
    err instanceof OpenAI.APIConnectionTimeoutError
  ) {
    return new AiProviderTransientError(`DeepSeek transport error: ${String(err)}`, err);
  }
  return new AiProviderInvalidRequestError(
    `DeepSeek unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    err,
  );
}
