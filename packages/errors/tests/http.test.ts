/**
 * `toHttp` tests — the HTTP-envelope contract.
 *
 * `toHttp` is wired into `apps/web/app/routes/webhooks.tsx` as of step 3
 * (closes gap B5). The shape verified here is what that route returns to
 * upstream callers (Shopify in production; operator dashboards on log
 * replay). Loosening any assertion below is a contract change that
 * needs a paired update to the wire-up.
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
  toHttp,
} from '../src/index.js';

const GENERIC_MESSAGE = 'Internal server error';

describe('toHttp — AppError subclasses produce the right status + body shape', () => {
  it('ValidationError → 400 + exposed message + code', () => {
    const result = toHttp(new ValidationError('email is required'));
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('validation.failed');
    expect(result.body.error.message).toBe('email is required');
  });

  it('ValidationError fields propagate into body.error.fields', () => {
    const e = new ValidationError('multiple field errors', {
      fields: { email: 'required', age: 'must be a number' },
    });
    const result = toHttp(e);
    expect(result.body.error.fields).toEqual({
      email: 'required',
      age: 'must be a number',
    });
  });

  it('UnauthorizedError → 401 + exposed message', () => {
    const result = toHttp(new UnauthorizedError('token expired'));
    expect(result.status).toBe(401);
    expect(result.body.error.message).toBe('token expired');
  });

  it('ForbiddenError → 403 + exposed message', () => {
    const result = toHttp(new ForbiddenError());
    expect(result.status).toBe(403);
    expect(result.body.error.message).toBe('Forbidden');
  });

  it('NotFoundError → 404 + exposed message', () => {
    const result = toHttp(new NotFoundError());
    expect(result.status).toBe(404);
    expect(result.body.error.message).toBe('Not found');
  });

  it('ConflictError → 409 + exposed message', () => {
    const result = toHttp(new ConflictError('duplicate sku'));
    expect(result.status).toBe(409);
    expect(result.body.error.message).toBe('duplicate sku');
  });

  it('RateLimitError → 429 + GENERIC message (not exposed)', () => {
    const result = toHttp(new RateLimitError('shopify says slow down — sensitive context'));
    expect(result.status).toBe(429);
    expect(result.body.error.message).toBe(GENERIC_MESSAGE);
    expect(result.body.error.code).toBe('rate_limit.exceeded');
  });

  it('TimeoutError → 504 + GENERIC message', () => {
    const result = toHttp(new TimeoutError());
    expect(result.status).toBe(504);
    expect(result.body.error.message).toBe(GENERIC_MESSAGE);
  });

  it('IntegrationError → 502 + GENERIC message (provider details stay in logs)', () => {
    const result = toHttp(
      new IntegrationError('shopify api: 502 from /admin/graphql.json', {
        provider: 'shopify',
        providerStatus: 502,
      }),
    );
    expect(result.status).toBe(502);
    expect(result.body.error.message).toBe(GENERIC_MESSAGE);
    expect(result.body.error.code).toBe('integration.failed');
  });

  it('TransientError → 503 + GENERIC message', () => {
    const result = toHttp(new TransientError('redis pool exhausted'));
    expect(result.status).toBe(503);
    expect(result.body.error.message).toBe(GENERIC_MESSAGE);
  });

  it('FatalError → 500 + GENERIC message', () => {
    const result = toHttp(new FatalError('corrupted encryption key'));
    expect(result.status).toBe(500);
    expect(result.body.error.message).toBe(GENERIC_MESSAGE);
  });

  it('raw AppError with exposeMessage=false → GENERIC message', () => {
    const e = new AppError({
      code: 'custom.error',
      message: 'leaks-internal-state-do-not-show',
      statusCode: 500,
    });
    const result = toHttp(e);
    expect(result.body.error.message).toBe(GENERIC_MESSAGE);
    expect(result.body.error.code).toBe('custom.error');
  });

  it('raw AppError with exposeMessage=true → original message', () => {
    const e = new AppError({
      code: 'custom.error',
      message: 'safe to show',
      statusCode: 418,
      exposeMessage: true,
    });
    const result = toHttp(e);
    expect(result.body.error.message).toBe('safe to show');
    expect(result.status).toBe(418);
  });
});

describe('toHttp — non-AppError throwables', () => {
  it('plain Error → 500 + internal.unknown code + GENERIC message', () => {
    const result = toHttp(new Error('internal stack trace details'));
    expect(result.status).toBe(500);
    expect(result.body.error.code).toBe('internal.unknown');
    expect(result.body.error.message).toBe(GENERIC_MESSAGE);
  });

  it('string thrown → 500 + internal.unknown', () => {
    const result = toHttp('rogue string throw');
    expect(result.status).toBe(500);
    expect(result.body.error.code).toBe('internal.unknown');
  });

  it('null thrown → 500 + internal.unknown', () => {
    const result = toHttp(null);
    expect(result.status).toBe(500);
    expect(result.body.error.code).toBe('internal.unknown');
  });

  it('object thrown → 500 + internal.unknown', () => {
    const result = toHttp({ shape: 'weird' });
    expect(result.status).toBe(500);
    expect(result.body.error.code).toBe('internal.unknown');
  });
});

describe('toHttp — ToHttpOptions', () => {
  it('requestId attaches to the body envelope when provided', () => {
    const result = toHttp(new ValidationError('bad input'), { requestId: 'req_abc123' });
    expect(result.body.error.requestId).toBe('req_abc123');
  });

  it('requestId omitted from body when option absent', () => {
    const result = toHttp(new ValidationError('bad input'));
    expect(result.body.error).not.toHaveProperty('requestId');
  });

  it('safeMessage overrides GENERIC for non-exposed AppErrors', () => {
    const result = toHttp(new IntegrationError('shopify 502'), {
      safeMessage: 'upstream provider failure',
    });
    expect(result.body.error.message).toBe('upstream provider failure');
  });

  it('safeMessage does NOT override exposed AppError messages', () => {
    const result = toHttp(new ValidationError('email is required'), {
      safeMessage: 'should not be used',
    });
    expect(result.body.error.message).toBe('email is required');
  });

  it('safeMessage overrides GENERIC for unknown throwables', () => {
    const result = toHttp(new Error('internal'), {
      safeMessage: 'webhook handler failure',
    });
    expect(result.body.error.message).toBe('webhook handler failure');
  });
});

describe('toHttp — body shape stability (regression guard)', () => {
  it('body is always { error: { code, message, ... } } — no extra top-level keys', () => {
    const result = toHttp(new ValidationError('bad'));
    expect(Object.keys(result.body)).toEqual(['error']);
  });

  it('body.error always has code + message (the two required fields)', () => {
    const result = toHttp('rogue throw');
    expect(result.body.error.code).toBeDefined();
    expect(result.body.error.message).toBeDefined();
  });

  it('body is JSON-serializable (no symbols, no functions, no circular refs)', () => {
    const e = new IntegrationError('shopify 502', {
      provider: 'shopify',
      providerStatus: 502,
    });
    const result = toHttp(e, { requestId: 'req_x' });
    const serialized = JSON.stringify(result.body);
    const parsed = JSON.parse(serialized) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('integration.failed');
    expect(parsed.error.message).toBe(GENERIC_MESSAGE);
  });
});
