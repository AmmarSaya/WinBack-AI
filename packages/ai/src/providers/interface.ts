/**
 * Provider abstraction layer (Epic F §F-1).
 *
 * Every LLM provider implements `AiProvider`. The AI Worker (batch 4) calls
 * the interface; it NEVER imports a provider SDK directly. Switching providers
 * is a single env-var change (`AI_PROVIDER=deepseek | openai | anthropic`).
 *
 * Provider methods THROW typed errors and return immediately on failure.
 * They do NOT loop, sleep, or implement retry. The BullMQ Worker (batch 4)
 * owns retry orchestration via the `retryable` discriminant on each error.
 *
 * Locked decisions:
 *   - L1: providers throw; no in-provider retry.
 *   - L2: `AiProviderError` is the abstract base. `code` is the stable
 *         cross-process identifier (the value stored in `AiGeneration.lastError`).
 *         Class names are NOT stable — refactors may rename classes; `code`
 *         strings are an external contract.
 *   - L3: each provider has its OWN SDK-error mapper. DeepSeek does NOT
 *         delegate to OpenAI's mapper (the 10% divergence is where production
 *         bugs hide).
 *   - L4: Anthropic content-block detection inspects RESPONSE shape
 *         (stop_reason, empty content array) as well as thrown errors.
 *   - L10: SDK error types (OpenAI.APIError, Anthropic.APIError, etc.) are
 *          NOT re-exported from the public surface. Callers see only the
 *          5 typed errors below.
 */

/** Provider name discriminant. Used in cost-rates lookups + log fields. */
export type AiProviderName = 'openai' | 'anthropic' | 'deepseek';

/**
 * Stable, cross-process error code. Persisted in `AiGeneration.lastError`
 * and surfaced in AuditLog rows.
 *
 * IMPORTANT: these strings are an EXTERNAL CONTRACT. They land in the
 * database, get queried by operator dashboards, and get matched against in
 * downstream consumer code. Adding a new code is fine; renaming or removing
 * a code is a coordinated change with the audit-actions registry + any
 * dashboard query that filters on it. Class names (e.g.
 * `AiProviderRateLimitError`) are NOT stable in the same sense — internal
 * refactors may rename classes without notice.
 */
export type AiProviderErrorCode =
  | 'rate_limit'
  | 'transient'
  | 'content_blocked'
  | 'auth'
  | 'invalid_request';

/**
 * Inputs to a single LLM call. The prompt builder (F-7) produces
 * `systemPrompt` + `userPrompt`; the AI Worker fills the rest from
 * `getAiConfig()` + the cost-rate model lookup.
 */
export interface AiGenerateArgs {
  /** Provider-specific model identifier (e.g. 'gpt-4.1-mini', 'claude-haiku-4-5'). */
  readonly model: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /** Max output tokens. Bounded by `AI_MAX_TOKENS` from `getAiConfig()`. */
  readonly maxTokens: number;
  /** Sampling temperature (0.0–2.0). Bounded by `AI_TEMPERATURE` from config. */
  readonly temperature: number;
}

/**
 * Successful generation result. The AI Worker (batch 4) reads `inputTokens`
 * + `outputTokens` and computes microcent cost via
 * `estimateCostMicrocents(provider, model, in, out)` from `cost-rates.ts`.
 */
export interface AiGenerateResult {
  readonly content: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** End-to-end SDK call latency in milliseconds. Provider measures locally. */
  readonly latencyMs: number;
}

/**
 * The single contract every provider implements. Synchronous failures (e.g.
 * config errors) throw before returning the promise; remote failures throw
 * after the SDK call resolves with an error response.
 *
 * Implementations MUST:
 *   1. Map SDK-specific errors to one of the 5 typed `AiProviderError`
 *      subclasses via a per-provider mapper (L3).
 *   2. Inspect the SDK's success response for content-filter signals and
 *      throw `AiProviderContentBlockedError` even on 200 OK responses (L4).
 *      Anthropic in particular returns 200 with `stop_reason: 'refusal'`.
 *   3. Measure latency locally (`Date.now()` deltas around the SDK call) so
 *      a slow provider is observable without per-provider SDK timing APIs.
 *   4. Never log raw API keys, raw prompts, or raw response bodies. The
 *      logger is for operator forensics; PII / model-output / secrets do
 *      NOT belong in log lines.
 */
export interface AiProvider {
  readonly name: AiProviderName;
  generate(args: AiGenerateArgs): Promise<AiGenerateResult>;
}

// ===========================================================================
// Typed error hierarchy
// ===========================================================================

/**
 * Abstract base. Catch this for generic provider-failure handling.
 *
 * Two discriminants:
 *   - `code: AiProviderErrorCode` — the stable, cross-process identifier
 *     used in DB + audit + dashboards. Refactor-safe.
 *   - `retryable: boolean` — feeds the BullMQ Worker's `isRetryable`
 *     classifier in batch 4. Drainer's DLQ logic short-circuits on
 *     `!isRetryable(err)` (locked rule #18).
 *
 * `cause` is preserved for operator forensics — wraps the original SDK
 * error or response object so the operator log line can dump the raw cause
 * without callers needing to handle SDK-specific shapes.
 */
export abstract class AiProviderError extends Error {
  abstract readonly code: AiProviderErrorCode;
  abstract readonly retryable: boolean;

  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** HTTP 429 from any provider. Retryable; BullMQ backs off + retries. */
export class AiProviderRateLimitError extends AiProviderError {
  override readonly code = 'rate_limit';
  override readonly retryable = true;
}

/**
 * HTTP 5xx, network timeout, ECONNRESET, or other transport-layer failures.
 * Retryable on the same backoff schedule as rate limits.
 */
export class AiProviderTransientError extends AiProviderError {
  override readonly code = 'transient';
  override readonly retryable = true;
}

/**
 * Content-policy block. NON-retryable. The same prompt will be blocked on
 * every retry; retrying wastes spend without changing the outcome.
 *
 * Detection paths:
 *   - OpenAI: response `finish_reason === 'content_filter'`.
 *   - Anthropic: response `stop_reason === 'refusal'` OR empty content array.
 *   - DeepSeek: empty content string in the response.
 *   - Any provider that throws a 400-with-content-policy-marker: mapped here.
 */
export class AiProviderContentBlockedError extends AiProviderError {
  override readonly code = 'content_blocked';
  override readonly retryable = false;
}

/**
 * HTTP 401 / 403. Provider API key is wrong, revoked, or scoped wrong.
 * NON-retryable; the next retry will fail identically. Operator alert
 * required — Epic F batch 4's worker emits a structured log + audit row.
 */
export class AiProviderAuthError extends AiProviderError {
  override readonly code = 'auth';
  override readonly retryable = false;
}

/**
 * HTTP 400 or any malformed-request failure. Usually indicates a
 * prompt-construction bug or a model-string mismatch. NON-retryable —
 * the same broken prompt produces the same 400 on retry.
 */
export class AiProviderInvalidRequestError extends AiProviderError {
  override readonly code = 'invalid_request';
  override readonly retryable = false;
}
