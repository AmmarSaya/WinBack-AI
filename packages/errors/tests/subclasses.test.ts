/**
 * Per-subclass defaults table-test. The 10 subclasses set status, retryable,
 * exposeMessage, and a default code — those defaults are the contract the
 * rest of the workspace (especially D2's error-handling decision tree)
 * builds against. The table makes regressions obvious.
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
} from '../src/index.js';

interface Row {
  readonly subclass: new (...args: never[]) => AppError;
  readonly name: string;
  readonly construct: () => AppError;
  readonly expectedStatus: number;
  readonly expectedRetryable: boolean;
  readonly expectedExpose: boolean;
  readonly expectedDefaultCode: string;
  /** Whether the constructor allows omitting the `message` arg (has a default). */
  readonly hasDefaultMessage: boolean;
}

const TABLE: readonly Row[] = [
  {
    subclass: ValidationError,
    name: 'ValidationError',
    construct: () => new ValidationError('field is required'),
    expectedStatus: 400,
    expectedRetryable: false,
    expectedExpose: true,
    expectedDefaultCode: 'validation.failed',
    hasDefaultMessage: false,
  },
  {
    subclass: UnauthorizedError,
    name: 'UnauthorizedError',
    construct: () => new UnauthorizedError(),
    expectedStatus: 401,
    expectedRetryable: false,
    expectedExpose: true,
    expectedDefaultCode: 'auth.unauthorized',
    hasDefaultMessage: true,
  },
  {
    subclass: ForbiddenError,
    name: 'ForbiddenError',
    construct: () => new ForbiddenError(),
    expectedStatus: 403,
    expectedRetryable: false,
    expectedExpose: true,
    expectedDefaultCode: 'auth.forbidden',
    hasDefaultMessage: true,
  },
  {
    subclass: NotFoundError,
    name: 'NotFoundError',
    construct: () => new NotFoundError(),
    expectedStatus: 404,
    expectedRetryable: false,
    expectedExpose: true,
    expectedDefaultCode: 'resource.not_found',
    hasDefaultMessage: true,
  },
  {
    subclass: ConflictError,
    name: 'ConflictError',
    construct: () => new ConflictError('duplicate'),
    expectedStatus: 409,
    expectedRetryable: false,
    expectedExpose: true,
    expectedDefaultCode: 'resource.conflict',
    hasDefaultMessage: false,
  },
  {
    subclass: RateLimitError,
    name: 'RateLimitError',
    construct: () => new RateLimitError(),
    expectedStatus: 429,
    expectedRetryable: true,
    expectedExpose: false,
    expectedDefaultCode: 'rate_limit.exceeded',
    hasDefaultMessage: true,
  },
  {
    subclass: TimeoutError,
    name: 'TimeoutError',
    construct: () => new TimeoutError(),
    expectedStatus: 504,
    expectedRetryable: true,
    expectedExpose: false,
    expectedDefaultCode: 'timeout.exceeded',
    hasDefaultMessage: true,
  },
  {
    subclass: IntegrationError,
    name: 'IntegrationError',
    construct: () => new IntegrationError('upstream 5xx'),
    expectedStatus: 502,
    expectedRetryable: true,
    expectedExpose: false,
    expectedDefaultCode: 'integration.failed',
    hasDefaultMessage: false,
  },
  {
    subclass: TransientError,
    name: 'TransientError',
    construct: () => new TransientError('temporary blip'),
    expectedStatus: 503,
    expectedRetryable: true,
    expectedExpose: false,
    expectedDefaultCode: 'transient.failed',
    hasDefaultMessage: false,
  },
  {
    subclass: FatalError,
    name: 'FatalError',
    construct: () => new FatalError('unrecoverable'),
    expectedStatus: 500,
    expectedRetryable: false,
    expectedExpose: false,
    expectedDefaultCode: 'fatal.unrecoverable',
    hasDefaultMessage: false,
  },
];

describe('subclass defaults', () => {
  it('exactly 10 named subclasses are tested (matches handoff)', () => {
    expect(TABLE.length).toBe(10);
  });

  for (const row of TABLE) {
    describe(row.name, () => {
      it('has the expected status / retryable / exposeMessage / code', () => {
        const e = row.construct();
        expect(e).toBeInstanceOf(AppError);
        expect(e).toBeInstanceOf(row.subclass);
        expect(e.name).toBe(row.name);
        expect(e.statusCode).toBe(row.expectedStatus);
        expect(e.retryable).toBe(row.expectedRetryable);
        expect(e.exposeMessage).toBe(row.expectedExpose);
        expect(e.code).toBe(row.expectedDefaultCode);
      });

      if (row.hasDefaultMessage) {
        it('has a default message when message arg omitted', () => {
          const e = row.construct();
          expect(typeof e.message).toBe('string');
          expect(e.message.length).toBeGreaterThan(0);
        });
      }
    });
  }
});

describe('subclass overrides', () => {
  it('ValidationError carries fields in context', () => {
    const e = new ValidationError('bad input', {
      fields: { email: 'must be present', age: 'must be a number' },
    });
    expect(e.context.fields).toEqual({
      email: 'must be present',
      age: 'must be a number',
    });
  });

  it('RateLimitError exposes retryAfterSeconds on the instance + in context', () => {
    const e = new RateLimitError('slow down', { retryAfterSeconds: 30 });
    expect(e.retryAfterSeconds).toBe(30);
    expect(e.context.retryAfterSeconds).toBe(30);
  });

  it('IntegrationError attaches provider + providerStatus to instance + context', () => {
    const e = new IntegrationError('shopify 502', {
      provider: 'shopify',
      providerStatus: 502,
    });
    expect(e.provider).toBe('shopify');
    expect(e.providerStatus).toBe(502);
    expect(e.context.provider).toBe('shopify');
    expect(e.context.providerStatus).toBe(502);
  });

  it('IntegrationError allows opting out of retryability', () => {
    const e = new IntegrationError('configuration error, do not retry', {
      retryable: false,
    });
    expect(e.retryable).toBe(false);
  });

  it('per-subclass code overrides survive', () => {
    const e = new ValidationError('bad input', { code: 'merchant_settings.ai_tone_invalid' });
    expect(e.code).toBe('merchant_settings.ai_tone_invalid');
  });

  it('cause survives the subclass constructor', () => {
    const root = new Error('underlying');
    const e = new ConflictError('dup key', { cause: root });
    expect(e.cause).toBe(root);
  });
});
