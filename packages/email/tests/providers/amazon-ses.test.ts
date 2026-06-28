import {
  AccountSuspendedException,
  BadRequestException,
  MailFromDomainNotVerifiedException,
  MessageRejected,
  type SESv2Client,
  type SendEmailCommandOutput,
  SendingPausedException,
  TooManyRequestsException,
} from '@aws-sdk/client-sesv2';
import { describe, expect, it, vi } from 'vitest';

import {
  AmazonSesProvider,
  buildSendEmailInput,
  mapSesError,
} from '../../src/providers/amazon-ses.js';
import {
  EmailProviderAccountSuspendedError,
  EmailProviderAuthError,
  EmailProviderInvalidRequestError,
  EmailProviderRateLimitError,
  EmailProviderRecipientSuppressedError,
  EmailProviderTransientError,
  type EmailSendArgs,
} from '../../src/providers/interface.js';

const baseArgs: EmailSendArgs = {
  from: 'winback@example.com',
  to: 'customer@example.com',
  subject: 'We miss you',
  html: '<p>Come back!</p>',
  correlationId: 'tgt_test_123',
  configurationSetName: 'winback-events',
};

// SES SDK exception classes require an internal `$fault` discriminator + a
// `$metadata` object — the SDK constructor signature varies enough across
// versions that we shape-build with the minimum fields the mapper reads.
function makeSdkException<T extends new (...a: never[]) => Error>(
  Cls: T,
  message: string,
  httpStatusCode?: number,
): InstanceType<T> {
  return Object.assign(Object.create(Cls.prototype), {
    name: Cls.name,
    message,
    $fault: 'client',
    $metadata: { httpStatusCode: httpStatusCode ?? 400 },
  }) as InstanceType<T>;
}

function makeClient(impl: () => Promise<SendEmailCommandOutput> | SendEmailCommandOutput): SESv2Client {
  return { send: vi.fn(impl) } as unknown as SESv2Client;
}

describe('AmazonSesProvider.send — happy path', () => {
  it('returns providerMessageId + measured latency', async () => {
    const client = makeClient(async () => ({
      MessageId: 'ses-msg-abc-123',
      $metadata: { httpStatusCode: 200 },
    }));
    const provider = new AmazonSesProvider(client);

    const result = await provider.send(baseArgs);

    expect(result.providerMessageId).toBe('ses-msg-abc-123');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('throws email_transient on a 200 with no MessageId (defensive)', async () => {
    const client = makeClient(async () => ({ $metadata: { httpStatusCode: 200 } }));
    const provider = new AmazonSesProvider(client);
    await expect(provider.send(baseArgs)).rejects.toBeInstanceOf(EmailProviderTransientError);
  });
});

describe('buildSendEmailInput — SES SendEmailCommand input shape', () => {
  it('sets EmailTags wbk_target = correlationId (the 8.5 SNS join key)', () => {
    const input = buildSendEmailInput(baseArgs);
    expect(input.EmailTags).toEqual([{ Name: 'wbk_target', Value: 'tgt_test_123' }]);
  });

  it('sets ConfigurationSetName when supplied (8.5 SNS routing)', () => {
    const input = buildSendEmailInput(baseArgs);
    expect(input.ConfigurationSetName).toBe('winback-events');
  });

  it('OMITS ConfigurationSetName when not supplied (SES default route)', () => {
    const { configurationSetName, ...argsNoCs } = baseArgs;
    void configurationSetName;
    const input = buildSendEmailInput(argsNoCs);
    expect(input.ConfigurationSetName).toBeUndefined();
  });

  it('renders Simple body with Html + UTF-8 charset; omits Text when absent', () => {
    const input = buildSendEmailInput(baseArgs);
    expect(input.Content?.Simple?.Body?.Html?.Data).toBe('<p>Come back!</p>');
    expect(input.Content?.Simple?.Body?.Html?.Charset).toBe('UTF-8');
    expect(input.Content?.Simple?.Body?.Text).toBeUndefined();
  });

  it('includes Text alternative when supplied', () => {
    const input = buildSendEmailInput({ ...baseArgs, text: 'Come back!' });
    expect(input.Content?.Simple?.Body?.Text?.Data).toBe('Come back!');
  });

  it('Destination has a single ToAddresses entry (v1 single-touch)', () => {
    const input = buildSendEmailInput(baseArgs);
    expect(input.Destination?.ToAddresses).toEqual(['customer@example.com']);
  });
});

describe('mapSesError — SDK exception → typed EmailProviderError', () => {
  it('TooManyRequestsException → email_rate_limit (retryable)', () => {
    const sdkErr = makeSdkException(TooManyRequestsException, 'Throttled', 429);
    const mapped = mapSesError(sdkErr);
    expect(mapped).toBeInstanceOf(EmailProviderRateLimitError);
  });

  it('AccountSuspendedException → email_account_suspended (non-retryable)', () => {
    const sdkErr = makeSdkException(AccountSuspendedException, 'Suspended', 400);
    expect(mapSesError(sdkErr)).toBeInstanceOf(EmailProviderAccountSuspendedError);
  });

  it('SendingPausedException → email_account_suspended (non-retryable)', () => {
    const sdkErr = makeSdkException(SendingPausedException, 'Paused', 400);
    expect(mapSesError(sdkErr)).toBeInstanceOf(EmailProviderAccountSuspendedError);
  });

  it('MailFromDomainNotVerifiedException → email_account_suspended (non-retryable)', () => {
    const sdkErr = makeSdkException(MailFromDomainNotVerifiedException, 'Unverified', 400);
    expect(mapSesError(sdkErr)).toBeInstanceOf(EmailProviderAccountSuspendedError);
  });

  it('MessageRejected with "Address blacklisted" → email_recipient_suppressed', () => {
    const sdkErr = makeSdkException(MessageRejected, 'Email address is blacklisted', 400);
    expect(mapSesError(sdkErr)).toBeInstanceOf(EmailProviderRecipientSuppressedError);
  });

  it('MessageRejected with "suppression list" → email_recipient_suppressed', () => {
    const sdkErr = makeSdkException(
      MessageRejected,
      'Recipient on account suppression list',
      400,
    );
    expect(mapSesError(sdkErr)).toBeInstanceOf(EmailProviderRecipientSuppressedError);
  });

  it('MessageRejected without suppression-list signal → email_invalid_request', () => {
    const sdkErr = makeSdkException(MessageRejected, 'Subject is empty', 400);
    expect(mapSesError(sdkErr)).toBeInstanceOf(EmailProviderInvalidRequestError);
  });

  it('BadRequestException → email_invalid_request (non-retryable)', () => {
    const sdkErr = makeSdkException(BadRequestException, 'Malformed input', 400);
    expect(mapSesError(sdkErr)).toBeInstanceOf(EmailProviderInvalidRequestError);
  });

  it('generic 403 → email_auth (non-retryable)', () => {
    const fauxErr = Object.assign(new Error('Signature mismatch'), {
      $metadata: { httpStatusCode: 403 },
    });
    expect(mapSesError(fauxErr)).toBeInstanceOf(EmailProviderAuthError);
  });

  it('generic 503 → email_transient (retryable)', () => {
    const fauxErr = Object.assign(new Error('Service unavailable'), {
      $metadata: { httpStatusCode: 503 },
    });
    expect(mapSesError(fauxErr)).toBeInstanceOf(EmailProviderTransientError);
  });

  it('unmapped non-SDK throw → email_transient (safer default; surfaces on retry)', () => {
    expect(mapSesError(new Error('socket hung up'))).toBeInstanceOf(
      EmailProviderTransientError,
    );
  });
});

describe('AmazonSesProvider.send — error mapping integration', () => {
  it('propagates a TooManyRequestsException as EmailProviderRateLimitError', async () => {
    const client = makeClient(async () => {
      throw makeSdkException(TooManyRequestsException, 'Throttled', 429);
    });
    const provider = new AmazonSesProvider(client);
    await expect(provider.send(baseArgs)).rejects.toBeInstanceOf(
      EmailProviderRateLimitError,
    );
  });
});
