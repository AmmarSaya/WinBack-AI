import { describe, expect, it } from 'vitest';

import {
  EmailProviderAccountSuspendedError,
  EmailProviderAuthError,
  EmailProviderError,
  EmailProviderInvalidRequestError,
  EmailProviderRateLimitError,
  EmailProviderRecipientSuppressedError,
  EmailProviderTransientError,
  type EmailProviderErrorCode,
} from '../../src/providers/interface.js';

/**
 * Locked, externally-contracted shape for the email provider typed errors.
 * Mirrors `packages/ai/tests/providers/interface.test.ts` posture: `code`
 * strings are persisted to DB (CampaignTarget.suppressedByGate; AuditLog
 * context) and must NEVER change without coordinated downstream updates.
 */

describe('EmailProviderError subclasses — stable code strings (DB-persisted contract)', () => {
  it('email_rate_limit is retryable', () => {
    const err = new EmailProviderRateLimitError('SES 429');
    expect(err.code satisfies EmailProviderErrorCode).toBe('email_rate_limit');
    expect(err.retryable).toBe(true);
    expect(err).toBeInstanceOf(EmailProviderError);
  });

  it('email_transient is retryable', () => {
    const err = new EmailProviderTransientError('SES 502');
    expect(err.code).toBe('email_transient');
    expect(err.retryable).toBe(true);
    expect(err).toBeInstanceOf(EmailProviderError);
  });

  it('email_auth is NON-retryable', () => {
    const err = new EmailProviderAuthError('SES 403');
    expect(err.code).toBe('email_auth');
    expect(err.retryable).toBe(false);
    expect(err).toBeInstanceOf(EmailProviderError);
  });

  it('email_invalid_request is NON-retryable', () => {
    const err = new EmailProviderInvalidRequestError('SES BadRequest');
    expect(err.code).toBe('email_invalid_request');
    expect(err.retryable).toBe(false);
    expect(err).toBeInstanceOf(EmailProviderError);
  });

  it('email_account_suspended is NON-retryable (operator-page-worthy)', () => {
    const err = new EmailProviderAccountSuspendedError('SES AccountSuspended');
    expect(err.code).toBe('email_account_suspended');
    expect(err.retryable).toBe(false);
    expect(err).toBeInstanceOf(EmailProviderError);
  });

  it('email_recipient_suppressed is NON-retryable (8.4 terminal-only, NO Suppression-row write — 8.5 owns)', () => {
    const err = new EmailProviderRecipientSuppressedError('SES Address blacklisted');
    expect(err.code).toBe('email_recipient_suppressed');
    expect(err.retryable).toBe(false);
    expect(err).toBeInstanceOf(EmailProviderError);
  });
});

describe('EmailProviderError — `cause` preservation', () => {
  it('wraps SDK error / response shape for operator forensics', () => {
    const sdkError = { name: 'TooManyRequestsException', message: 'rate' };
    const err = new EmailProviderRateLimitError('rl', sdkError);
    expect(err.cause).toBe(sdkError);
  });
});
