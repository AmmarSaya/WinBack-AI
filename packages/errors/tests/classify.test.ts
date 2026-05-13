/**
 * Classifiers + coercers: isAppError, isClientError, isServerError,
 * isRetryable, fromUnknown, wrap.
 *
 * isRetryable is the load-bearing one for D2 — the outbox drainer's
 * decision tree (retry vs dead-letter) keys on it. Exhaustive coverage
 * against every subclass + the unknown-error fallback policy below.
 */

import { describe, expect, it } from 'vitest';

import {
  AppError,
  ConflictError,
  FatalError,
  ForbiddenError,
  IntegrationError,
  NotFoundError,
  RateLimitError,
  TimeoutError,
  TransientError,
  UnauthorizedError,
  ValidationError,
  fromUnknown,
  isAppError,
  isClientError,
  isRetryable,
  isServerError,
  wrap,
} from '../src/index.js';

// ===========================================================================
// isAppError
// ===========================================================================

describe('isAppError', () => {
  it('true for AppError instances', () => {
    expect(isAppError(new AppError({ code: 'x.y', message: 'boom' }))).toBe(true);
    expect(isAppError(new ValidationError('bad'))).toBe(true);
    expect(isAppError(new TimeoutError())).toBe(true);
  });

  it('false for plain Error instances', () => {
    expect(isAppError(new Error('boom'))).toBe(false);
    expect(isAppError(new TypeError('boom'))).toBe(false);
  });

  it('false for non-Error throwables', () => {
    expect(isAppError('string')).toBe(false);
    expect(isAppError(42)).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError(undefined)).toBe(false);
    expect(isAppError({ message: 'plain object' })).toBe(false);
  });
});

// ===========================================================================
// isClientError / isServerError
// ===========================================================================

describe('isClientError', () => {
  it('true for 4xx AppErrors', () => {
    expect(isClientError(new ValidationError('x'))).toBe(true); // 400
    expect(isClientError(new UnauthorizedError())).toBe(true); // 401
    expect(isClientError(new ForbiddenError())).toBe(true); // 403
    expect(isClientError(new NotFoundError())).toBe(true); // 404
    expect(isClientError(new ConflictError('x'))).toBe(true); // 409
    expect(isClientError(new RateLimitError())).toBe(true); // 429
  });

  it('false for 5xx AppErrors', () => {
    expect(isClientError(new IntegrationError('x'))).toBe(false); // 502
    expect(isClientError(new TransientError('x'))).toBe(false); // 503
    expect(isClientError(new TimeoutError())).toBe(false); // 504
    expect(isClientError(new FatalError('x'))).toBe(false); // 500
  });

  it('false for non-AppError throwables (server-side responsibility by default)', () => {
    expect(isClientError(new Error('x'))).toBe(false);
    expect(isClientError('string')).toBe(false);
    expect(isClientError(null)).toBe(false);
  });
});

describe('isServerError', () => {
  it('true for 5xx AppErrors', () => {
    expect(isServerError(new IntegrationError('x'))).toBe(true);
    expect(isServerError(new FatalError('x'))).toBe(true);
    expect(isServerError(new TimeoutError())).toBe(true);
  });

  it('false for 4xx AppErrors', () => {
    expect(isServerError(new ValidationError('x'))).toBe(false);
    expect(isServerError(new RateLimitError())).toBe(false);
  });

  it('true for non-AppError throwables (default to server-fault)', () => {
    expect(isServerError(new Error('x'))).toBe(true);
    expect(isServerError('string')).toBe(true);
    expect(isServerError(null)).toBe(true);
  });
});

// ===========================================================================
// isRetryable — load-bearing for D2
// ===========================================================================

describe('isRetryable', () => {
  it('false for non-retryable client AppErrors', () => {
    expect(isRetryable(new ValidationError('bad input'))).toBe(false);
    expect(isRetryable(new UnauthorizedError())).toBe(false);
    expect(isRetryable(new ForbiddenError())).toBe(false);
    expect(isRetryable(new NotFoundError())).toBe(false);
    expect(isRetryable(new ConflictError('dup'))).toBe(false);
  });

  it('true for retryable subclasses (rate-limit, timeout, integration, transient)', () => {
    expect(isRetryable(new RateLimitError())).toBe(true);
    expect(isRetryable(new TimeoutError())).toBe(true);
    expect(isRetryable(new IntegrationError('5xx upstream'))).toBe(true);
    expect(isRetryable(new TransientError('blip'))).toBe(true);
  });

  it('false for FatalError', () => {
    expect(isRetryable(new FatalError('boom'))).toBe(false);
  });

  it('respects per-instance retryable override', () => {
    const optedIn = new ValidationError('x'); // default false
    const optedOut = new IntegrationError('x', { retryable: false });
    expect(isRetryable(optedIn)).toBe(false);
    expect(isRetryable(optedOut)).toBe(false);
  });

  it('true for unknown throwables (D2 fallback policy: assume transient)', () => {
    expect(isRetryable(new Error('unknown'))).toBe(true);
    expect(isRetryable('string')).toBe(true);
    expect(isRetryable(undefined)).toBe(true);
    expect(isRetryable(null)).toBe(true);
    expect(isRetryable({ obj: 1 })).toBe(true);
  });

  it('true for raw AppError with explicit retryable=true', () => {
    const e = new AppError({ code: 'x.y', message: 'boom', retryable: true });
    expect(isRetryable(e)).toBe(true);
  });
});

// ===========================================================================
// fromUnknown
// ===========================================================================

describe('fromUnknown', () => {
  it('returns the same instance if already an AppError', () => {
    const original = new ValidationError('bad input');
    const result = fromUnknown(original);
    expect(result).toBe(original);
  });

  it('preserves subclass identity when passed through', () => {
    const original = new TimeoutError();
    const result = fromUnknown(original);
    expect(result).toBeInstanceOf(TimeoutError);
    expect(result.statusCode).toBe(504);
    expect(result.retryable).toBe(true);
  });

  it('wraps a plain Error with cause + default 500 + retryable=true', () => {
    const root = new Error('underlying');
    const result = fromUnknown(root);
    expect(result).toBeInstanceOf(AppError);
    expect(result).not.toBeInstanceOf(TimeoutError); // not a fancy subclass
    expect(result.code).toBe('internal.unknown');
    expect(result.message).toBe('underlying');
    expect(result.statusCode).toBe(500);
    expect(result.retryable).toBe(true);
    expect(result.cause).toBe(root);
  });

  it('wraps a non-Error throwable (string) with default message', () => {
    const result = fromUnknown('thrown string');
    expect(result).toBeInstanceOf(AppError);
    expect(result.message).toBe('Unknown error');
    expect(result.cause).toBe('thrown string');
  });

  it('wraps null/undefined as cause', () => {
    const a = fromUnknown(null);
    const b = fromUnknown(undefined);
    expect(a.cause).toBeNull();
    expect(b.cause).toBeUndefined();
    expect(a.message).toBe('Unknown error');
    expect(b.message).toBe('Unknown error');
  });

  it('wraps an arbitrary object as cause', () => {
    const obj = { kind: 'weird' };
    const result = fromUnknown(obj);
    expect(result.cause).toBe(obj);
    expect(result.code).toBe('internal.unknown');
  });

  it('applies caller-provided defaults over the built-in fallbacks', () => {
    const result = fromUnknown('boom', {
      code: 'webhook.parse_failed',
      message: 'failed to parse webhook payload',
      statusCode: 400,
      retryable: false,
    });
    expect(result.code).toBe('webhook.parse_failed');
    expect(result.message).toBe('failed to parse webhook payload');
    expect(result.statusCode).toBe(400);
    expect(result.retryable).toBe(false);
  });

  it('caller defaults do NOT override an already-AppError input (passthrough wins)', () => {
    const e = new ValidationError('original');
    const result = fromUnknown(e, {
      code: 'should.not.apply',
      statusCode: 999,
    });
    expect(result).toBe(e);
    expect(result.code).toBe('validation.failed');
    expect(result.statusCode).toBe(400);
  });
});

// ===========================================================================
// wrap
// ===========================================================================

describe('wrap', () => {
  it('produces a new AppError carrying the original as cause', () => {
    const root = new Error('underlying');
    const result = wrap(root, { code: 'webhook.crash', message: 'webhook handler crashed' });
    expect(result).toBeInstanceOf(AppError);
    expect(result.code).toBe('webhook.crash');
    expect(result.message).toBe('webhook handler crashed');
    expect(result.cause).toBe(root);
  });

  it('respects statusCode + retryable overrides', () => {
    const result = wrap(new Error('x'), {
      code: 'a.b',
      message: 'm',
      statusCode: 422,
      retryable: true,
    });
    expect(result.statusCode).toBe(422);
    expect(result.retryable).toBe(true);
  });

  it('uses AppError defaults when statusCode/retryable omitted', () => {
    const result = wrap(new Error('x'), { code: 'a.b', message: 'm' });
    expect(result.statusCode).toBe(500);
    expect(result.retryable).toBe(false);
  });

  it('does NOT preserve subclass identity (always returns AppError)', () => {
    // wrap always reclassifies — it's the intentional escape hatch.
    // Callers that want to preserve subclass should pass through directly.
    const original = new ValidationError('original');
    const result = wrap(original, { code: 'reclassified', message: 'new label' });
    expect(result).toBeInstanceOf(AppError);
    expect(result).not.toBeInstanceOf(ValidationError);
    expect(result.code).toBe('reclassified');
    expect(result.cause).toBe(original);
  });

  it('preserves caller-supplied context', () => {
    const result = wrap(new Error('x'), {
      code: 'a.b',
      message: 'm',
      context: { merchantId: 'm_1', step: 7 },
    });
    expect(result.context).toMatchObject({ merchantId: 'm_1', step: 7 });
  });

  it('accepts a non-Error throwable as the source', () => {
    const result = wrap('raw string', { code: 'a.b', message: 'wrapped' });
    expect(result.cause).toBe('raw string');
  });
});
