/**
 * Provider abstraction layer (Epic G batch 8.4 — the ESP boundary).
 *
 * Every email provider implements `EmailProvider`. The dispatch worker
 * (`apps/drainer/src/workers/dispatch.worker.ts`) calls the interface; it
 * NEVER imports a provider SDK directly. Switching providers is a single
 * env-var change (`EMAIL_PROVIDER=amazon-ses` is the only live value at
 * 8.4; future providers join the discriminated union without code churn at
 * the call site). The shape mirrors `@winback/ai`'s `AiProvider` boundary
 * for consistency.
 *
 * SHAPE DIFFERENCE from AiProvider (load-bearing):
 *   An LLM call is request → response (the SDK call returns the answer).
 *   An email send is request → ACK + providerMessageId. The real
 *   delivered / bounced / complained outcome arrives LATER via SES SNS
 *   notifications (8.5's concern, NOT 8.4). So `send()` returns an
 *   ACCEPTANCE, not a delivery confirmation. The interface name
 *   `EmailSendAccepted` (not `EmailSendResult`) carries this distinction.
 *
 * NO PROVIDER-SIDE IDEMPOTENCY (verified against the SESv2 SendEmail API
 * reference, 2026-06-28): SES SendEmail accepts no client-side dedup
 * token (no `ClientToken` / `IdempotencyToken` / `RequestId` field).
 * Exactly-once delivery semantics live ENTIRELY on our side — the DB
 * tombstone state machine in `CampaignRepository.startSending` +
 * `markSentWithQuota` (Phase 1 §2 of 8.4). Future provider implementations
 * that DO support a dedup token may pass it via `EmailSendArgs.providerHints`
 * (placeholder, NOT used at 8.4).
 *
 * Provider methods THROW typed errors and return immediately on failure.
 * They do NOT loop, sleep, or implement retry. The dispatch worker owns
 * retry orchestration: a `retryable` error triggers `revertToPending` →
 * BullMQ retry; a non-retryable error triggers `resolveTerminal({status:
 * 'failed' | 'suppressed'})`. See `dispatch.worker.ts` for the exact flow.
 *
 * Locked decisions (mirror `AiProvider.interface.ts` L1–L4):
 *   - L1: providers throw; no in-provider retry.
 *   - L2: `EmailProviderError` is the abstract base. `code` is the stable
 *         cross-process identifier (the value stored in
 *         `AuditLog.context.errorCode` for `dispatch.suppressed_by_ses` and
 *         in `CampaignTarget.suppressedByGate` for non-retryable failures).
 *         Class names are NOT stable.
 *   - L3: each provider has its OWN SDK-error mapper. SES maps the SESv2
 *         exception classes from `@aws-sdk/client-sesv2`.
 *   - L4: SDK error types (e.g. `SESv2ServiceException`) are NOT re-exported
 *         from the public surface. Callers see only the 6 typed errors
 *         below.
 */

/** Provider name discriminant. Single live value at 8.4; future providers join the union. */
export type EmailProviderName = 'amazon-ses';

/**
 * Stable, cross-process error code. Persisted in
 * `CampaignTarget.suppressedByGate` (non-retryable failures) and in
 * `AuditLog.context.errorCode` (the `dispatch.suppressed_by_ses` row).
 *
 * IMPORTANT: these strings are an EXTERNAL CONTRACT. They land in the
 * database, get queried by operator dashboards, and are matched against
 * by downstream consumer code. Adding a new code is fine; renaming or
 * removing a code is a coordinated change with the audit-actions registry
 * + any dashboard query that filters on it.
 */
export type EmailProviderErrorCode =
  | 'email_rate_limit'
  | 'email_transient'
  | 'email_auth'
  | 'email_invalid_request'
  | 'email_account_suspended'
  | 'email_recipient_suppressed';

/**
 * Inputs to a single SES send.
 *
 * `correlationId` is a load-bearing 8.5 SNS-correlation key — currently
 * `CampaignTarget.id`. The SES provider passes this through as an
 * `EmailTags` entry (`{Name:'wbk_target', Value: correlationId}`) which
 * SES preserves into the eventual SNS event payload at `mail.tags`. Even
 * if the SES ACK is lost (ACK-LOST crash window), the SNS event reaching
 * 8.5 will carry this tag and identify the originating row — letting 8.5
 * auto-resolve a stuck `sending` target without manual operator action.
 *
 * `configurationSetName` is the SES configuration set whose
 * event-destination is the SNS topic 8.5 consumes. Set at every send;
 * the SES-side wiring (configuration set → SNS topic → 8.5's webhook
 * route) is a deployment concern (created once in the AWS console).
 */
export interface EmailSendArgs {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text?: string;
  readonly correlationId: string;
  readonly configurationSetName?: string;
}

/**
 * SES-accepted send. `providerMessageId` is the SES `MessageId` from the
 * SendEmail response — written to `Message.providerMessageId` by the
 * completion-tx (`CampaignRepository.markSentWithQuota`) and used by 8.5's
 * SNS handler to advance the lifecycle (delivered / opened / clicked) or
 * write a `Suppression` row (bounced / complained).
 *
 * `latencyMs` is measured locally around the SDK call (the SES SDK does
 * not surface per-call latency).
 */
export interface EmailSendAccepted {
  readonly providerMessageId: string;
  readonly latencyMs: number;
}

/**
 * The single contract every provider implements. Synchronous failures
 * (config errors) throw before returning the promise; remote failures
 * throw after the SDK call resolves with an error response.
 *
 * Implementations MUST:
 *   1. Map SDK-specific errors to one of the 6 typed `EmailProviderError`
 *      subclasses via a per-provider mapper (L3).
 *   2. Measure latency locally (`Date.now()` deltas around the SDK call)
 *      so a slow provider is observable without per-provider SDK timing
 *      APIs.
 *   3. Never log API keys, recipient addresses, or message bodies. The
 *      logger is for operator forensics; PII / secrets / customer-facing
 *      content does NOT belong in log lines.
 *   4. Set the `EmailTags` correlation entry on every send so 8.5's SNS
 *      auto-resolve path works (see `EmailSendArgs.correlationId`).
 */
export interface EmailProvider {
  readonly name: EmailProviderName;
  send(args: EmailSendArgs): Promise<EmailSendAccepted>;
}

// ===========================================================================
// Typed error hierarchy
// ===========================================================================

/**
 * Abstract base. Catch this for generic provider-failure handling.
 *
 * Two discriminants (mirror `AiProviderError`):
 *   - `code: EmailProviderErrorCode` — the stable, cross-process identifier
 *     used in DB + audit + dashboards. Refactor-safe.
 *   - `retryable: boolean` — feeds the dispatch worker's classifier. A
 *     retryable failure triggers `revertToPending` + rethrow (BullMQ retries
 *     re-enter the send path cleanly). A non-retryable failure triggers
 *     `resolveTerminal({status: 'failed' | 'suppressed'})` — terminal,
 *     no retry.
 *
 * `cause` is preserved for operator forensics — wraps the original SDK
 * error or response object so the log line can dump the raw cause without
 * callers handling SDK-specific shapes.
 */
export abstract class EmailProviderError extends Error {
  abstract readonly code: EmailProviderErrorCode;
  abstract readonly retryable: boolean;

  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

/**
 * HTTP 429 / `TooManyRequestsException`. Retryable.
 *
 * Worker flow: row stays at `sending` from the pre-send tx, the worker
 * calls `revertToPending` (CAS `sending → pending`), then rethrows. BullMQ
 * retries the job; the next attempt re-enters the send path cleanly via
 * the standard `pending → sending` pre-send tx. Without `revertToPending`,
 * the replay guard would short-circuit `sending` forever — a transient
 * SES rate limit would become a permanently stuck row.
 */
export class EmailProviderRateLimitError extends EmailProviderError {
  override readonly code = 'email_rate_limit';
  override readonly retryable = true;
}

/**
 * HTTP 5xx, network timeout, ECONNRESET, or other transport-layer failures.
 * Retryable on the same `revertToPending` + rethrow path as rate-limits.
 */
export class EmailProviderTransientError extends EmailProviderError {
  override readonly code = 'email_transient';
  override readonly retryable = true;
}

/**
 * Signature / IAM / 401-403. Provider credentials are wrong, revoked, or
 * scoped wrong. NON-retryable; same call fails identically on retry.
 *
 * Worker flow: row goes `sending → failed` via `resolveTerminal({status:
 * 'failed', reason: 'email_auth'})`. The Message also flips to `failed`
 * (a burned draft must NOT look dispatchable again). Operator alert via
 * standard log + the suppressedByGate value visible in dashboards.
 */
export class EmailProviderAuthError extends EmailProviderError {
  override readonly code = 'email_auth';
  override readonly retryable = false;
}

/**
 * `BadRequestException` / `MessageRejected` (HTTP 400). Usually a malformed
 * address, a missing required field, or content the SES content-filter
 * rejected. NON-retryable — the same broken request produces the same 400.
 */
export class EmailProviderInvalidRequestError extends EmailProviderError {
  override readonly code = 'email_invalid_request';
  override readonly retryable = false;
}

/**
 * SES account-level failures (`AccountSuspendedException`,
 * `SendingPausedException`, `MailFromDomainNotVerifiedException`). The
 * merchant's sending capacity is impaired account-wide — retrying this
 * row will fail identically AND every concurrent send will too. NON-
 * retryable; operator-page-worthy.
 *
 * Worker flow: same as `email_auth` — `resolveTerminal({status: 'failed',
 * reason: 'email_account_suspended'})`. The aggregate failure pattern is
 * the operator signal; this code per-row is the forensic trail.
 */
export class EmailProviderAccountSuspendedError extends EmailProviderError {
  override readonly code = 'email_account_suspended';
  override readonly retryable = false;
}

/**
 * SES recipient is on the SES account-suppression list — the synchronous
 * failure surface for a known-bad address. NON-retryable.
 *
 * Worker flow: `resolveTerminal({status: 'suppressed', reason:
 * 'ses_suppressed'})` AND write `dispatch.suppressed_by_ses` audit row.
 * The `Suppression` table is NOT written from this path — Suppression
 * writes are deferred to 8.5's unified path (CSV import + SNS bounces/
 * complaints + this case) so all three sources flow through one method
 * with consistent ingestion semantics.
 */
export class EmailProviderRecipientSuppressedError extends EmailProviderError {
  override readonly code = 'email_recipient_suppressed';
  override readonly retryable = false;
}
