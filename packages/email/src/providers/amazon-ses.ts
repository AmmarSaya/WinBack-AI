import {
  SESv2Client,
  SendEmailCommand,
  type SendEmailCommandInput,
  type SendEmailCommandOutput,
  AccountSuspendedException,
  BadRequestException,
  MailFromDomainNotVerifiedException,
  MessageRejected,
  SendingPausedException,
  TooManyRequestsException,
} from '@aws-sdk/client-sesv2';

import {
  EmailProviderAccountSuspendedError,
  EmailProviderAuthError,
  EmailProviderInvalidRequestError,
  EmailProviderRateLimitError,
  EmailProviderRecipientSuppressedError,
  EmailProviderTransientError,
  type EmailProvider,
  type EmailSendAccepted,
  type EmailSendArgs,
} from './interface.js';

/**
 * Amazon SES (SESv2) provider. Sends a single email via `SendEmailCommand`
 * and returns the SES `MessageId` as `providerMessageId`.
 *
 * Sandbox-build assumption (locked 2026-06-28): callers run against the SES
 * SANDBOX (verified test addresses only; no purchased domain; no
 * prod-out-of-sandbox access required for 8.4). Sandbox-exit is a
 * launch-time deployment decision; the provider code is unchanged by it.
 *
 * EmailTags wbk_target correlation: every send includes
 * `EmailTags: [{Name: 'wbk_target', Value: args.correlationId}]`. SES
 * preserves this tag through to the eventual SNS event payload at
 * `mail.tags`, giving 8.5's SNS auto-resolve handler a join key even
 * when the original SES ACK was lost.
 *
 * Configuration set: every send carries `ConfigurationSetName` if
 * supplied. The configuration set is the SES-side wiring that routes
 * delivery / bounce / complaint events to the SNS topic 8.5 consumes;
 * it's a deployment artifact (created once in the AWS console / IAC),
 * not provisioned by the code.
 *
 * NO retry, NO sleep, NO logging of API keys, recipient addresses, or
 * message bodies. The dispatch worker owns retry orchestration; the
 * logger surfaces forensic context (jobId, messageId, providerMessageId
 * on success / `EmailProviderErrorCode` on failure) — never the email
 * payload.
 */
export class AmazonSesProvider implements EmailProvider {
  readonly name = 'amazon-ses' as const;

  constructor(private readonly client: SESv2Client) {}

  async send(args: EmailSendArgs): Promise<EmailSendAccepted> {
    const input = buildSendEmailInput(args);
    const startedAt = Date.now();
    let response: SendEmailCommandOutput;
    try {
      response = await this.client.send(new SendEmailCommand(input));
    } catch (err) {
      throw mapSesError(err);
    }
    const latencyMs = Date.now() - startedAt;
    const providerMessageId = response.MessageId;
    if (providerMessageId === undefined || providerMessageId === '') {
      // SES returned 200 with no MessageId — never observed in the wild,
      // but the SDK types declare MessageId optional. Treat as transient
      // (the worker will revertToPending + retry; the next attempt will
      // either succeed cleanly or fail with a typed error).
      throw new EmailProviderTransientError(
        'SES SendEmail returned 200 with no MessageId',
        response,
      );
    }
    return { providerMessageId, latencyMs };
  }
}

/**
 * Construct a production `AmazonSesProvider` from explicit credentials.
 * 8.4 uses explicit env-supplied credentials (sandbox build); IAM-role /
 * AWS-SDK-default-chain support is a launch-time deployment switch — the
 * SDK falls back to the default chain when `credentials` is omitted, so
 * no provider-code change needed when that flip happens.
 */
export function createAmazonSesProvider(config: {
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}): AmazonSesProvider {
  const client = new SESv2Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return new AmazonSesProvider(client);
}

/**
 * Pure args → SES SendEmailCommand input mapper. Exported for unit-test
 * inspection (asserts that EmailTags / ConfigurationSetName / Content are
 * shaped correctly).
 */
export function buildSendEmailInput(args: EmailSendArgs): SendEmailCommandInput {
  const body: { Html?: { Data: string; Charset?: string }; Text?: { Data: string; Charset?: string } } = {
    Html: { Data: args.html, Charset: 'UTF-8' },
  };
  if (args.text !== undefined && args.text !== '') {
    body.Text = { Data: args.text, Charset: 'UTF-8' };
  }
  const input: SendEmailCommandInput = {
    FromEmailAddress: args.from,
    Destination: { ToAddresses: [args.to] },
    Content: {
      Simple: {
        Subject: { Data: args.subject, Charset: 'UTF-8' },
        Body: body,
      },
    },
    // wbk_target = the load-bearing 8.5 SNS correlation key (Phase 1 §1 of 8.4).
    EmailTags: [{ Name: 'wbk_target', Value: args.correlationId }],
  };
  if (args.configurationSetName !== undefined && args.configurationSetName !== '') {
    input.ConfigurationSetName = args.configurationSetName;
  }
  return input;
}

/**
 * SDK-error mapper. Per L3, SES has its OWN mapper — each SESv2 exception
 * class maps to a typed `EmailProviderError`. The class instanceof checks
 * are the primary routing; the `$metadata?.httpStatusCode` is a fallback
 * for SDK-version drift.
 *
 * Status routing summary:
 *   - `TooManyRequestsException`              → email_rate_limit       (retryable)
 *   - 5xx / connection / timeout              → email_transient        (retryable)
 *   - `AccountSuspendedException` / `SendingPausedException`
 *     / `MailFromDomainNotVerifiedException` → email_account_suspended (non-retryable)
 *   - `MessageRejected` ⇒ "Address blacklisted"
 *     (= SES account-suppression-list hit)   → email_recipient_suppressed (non-retryable)
 *   - Other `MessageRejected`                 → email_invalid_request  (non-retryable)
 *   - `BadRequestException`                   → email_invalid_request  (non-retryable)
 *   - 401 / 403 / signature                   → email_auth             (non-retryable)
 *   - unmapped                                → email_transient        (retryable — safer default)
 */
export function mapSesError(err: unknown): Error {
  if (err instanceof TooManyRequestsException) {
    return new EmailProviderRateLimitError(
      `SES rate limit: ${err.message}`,
      err,
    );
  }
  if (
    err instanceof AccountSuspendedException ||
    err instanceof SendingPausedException ||
    err instanceof MailFromDomainNotVerifiedException
  ) {
    return new EmailProviderAccountSuspendedError(
      `SES account-level failure (${err.name}): ${err.message}`,
      err,
    );
  }
  if (err instanceof MessageRejected) {
    // SES surfaces the recipient-on-suppression-list case as `MessageRejected`
    // with a specific message. Match defensively: "Address blacklisted" is the
    // documented phrase; "suppressed" / "suppression list" are observed
    // variants. A miss here falls through to `email_invalid_request` (still
    // non-retryable, so worker behavior is unchanged) — only the forensic
    // code string differs. Same defense-in-depth approach as the AI provider's
    // 400-message regex.
    const text = err.message;
    if (/blacklist|suppressed|suppression/i.test(text)) {
      return new EmailProviderRecipientSuppressedError(
        `SES recipient suppressed: ${text}`,
        err,
      );
    }
    return new EmailProviderInvalidRequestError(
      `SES message rejected: ${text}`,
      err,
    );
  }
  if (err instanceof BadRequestException) {
    return new EmailProviderInvalidRequestError(
      `SES bad request: ${err.message}`,
      err,
    );
  }

  // Generic shape from any other SDK throw: inspect `$metadata.httpStatusCode`.
  const status = readHttpStatus(err);
  const message = err instanceof Error ? err.message : String(err);
  if (status === 401 || status === 403) {
    return new EmailProviderAuthError(
      `SES auth failed (${String(status)}): ${message}`,
      err,
    );
  }
  if (status === 429) {
    return new EmailProviderRateLimitError(
      `SES rate limit (${String(status)}): ${message}`,
      err,
    );
  }
  if (status !== undefined && status >= 500 && status < 600) {
    return new EmailProviderTransientError(
      `SES server error (${String(status)}): ${message}`,
      err,
    );
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return new EmailProviderInvalidRequestError(
      `SES unmapped 4xx (${String(status)}): ${message}`,
      err,
    );
  }
  // Connection errors, timeouts, unknown shapes → transient (the safer
  // default; a true non-retryable will surface again on the retry).
  return new EmailProviderTransientError(
    `SES transport/unknown error: ${message}`,
    err,
  );
}

/**
 * Extract `$metadata.httpStatusCode` from an SDK error without assuming a
 * specific class hierarchy (SDK versions add / rename properties).
 */
function readHttpStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const meta = (err as { readonly $metadata?: { readonly httpStatusCode?: number } }).$metadata;
  return meta?.httpStatusCode;
}
