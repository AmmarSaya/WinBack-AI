/**
 * AppError base-class behavior. Defaults + overrides + ES2022 cause + frozen
 * context. The 10 subclasses lean on these defaults via super({...}), so
 * regressions here break every other test in the package.
 */

import { describe, expect, it } from 'vitest';

import { AppError } from '../src/app-error.js';

describe('AppError construction defaults', () => {
  it('sets statusCode=500, retryable=false, exposeMessage=false by default', () => {
    const e = new AppError({ code: 'x.y', message: 'boom' });
    expect(e.code).toBe('x.y');
    expect(e.message).toBe('boom');
    expect(e.statusCode).toBe(500);
    expect(e.retryable).toBe(false);
    expect(e.exposeMessage).toBe(false);
  });

  it('respects caller overrides', () => {
    const e = new AppError({
      code: 'x.y',
      message: 'boom',
      statusCode: 418,
      retryable: true,
      exposeMessage: true,
    });
    expect(e.statusCode).toBe(418);
    expect(e.retryable).toBe(true);
    expect(e.exposeMessage).toBe(true);
  });

  it('is an instance of Error (catchable by generic handlers)', () => {
    const e = new AppError({ code: 'x.y', message: 'boom' });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(AppError);
  });

  it('name defaults to "AppError"', () => {
    const e = new AppError({ code: 'x.y', message: 'boom' });
    expect(e.name).toBe('AppError');
  });
});

describe('AppError.cause propagation (ES2022)', () => {
  it('preserves an Error cause', () => {
    const root = new Error('underlying');
    const e = new AppError({ code: 'x.y', message: 'wrapped', cause: root });
    expect(e.cause).toBe(root);
  });

  it('preserves a non-Error cause (string)', () => {
    const e = new AppError({ code: 'x.y', message: 'wrapped', cause: 'string thrown' });
    expect(e.cause).toBe('string thrown');
  });

  it('preserves a null cause when passed explicitly', () => {
    const e = new AppError({ code: 'x.y', message: 'wrapped', cause: null });
    expect(e.cause).toBeNull();
  });

  it('omits cause property when not provided', () => {
    const e = new AppError({ code: 'x.y', message: 'no cause' });
    // ES2022: cause is undefined when not constructed with cause.
    expect(e.cause).toBeUndefined();
  });
});

describe('AppError.context', () => {
  it('defaults to empty frozen object when omitted', () => {
    const e = new AppError({ code: 'x.y', message: 'boom' });
    expect(e.context).toEqual({});
    expect(Object.isFrozen(e.context)).toBe(true);
  });

  it('copies the provided context defensively (frozen, mutations to source do not leak)', () => {
    const source: Record<string, unknown> = { merchantId: 'm_1', count: 42 };
    const e = new AppError({ code: 'x.y', message: 'boom', context: source });
    expect(e.context).toEqual({ merchantId: 'm_1', count: 42 });
    expect(Object.isFrozen(e.context)).toBe(true);
    // Mutating source after construction must not reach into AppError's copy.
    source['merchantId'] = 'm_2';
    expect(e.context).toEqual({ merchantId: 'm_1', count: 42 });
  });

  it('refuses to be mutated after construction', () => {
    const e = new AppError({ code: 'x.y', message: 'boom', context: { a: 1 } });
    // Frozen — assigning silently fails in non-strict mode, throws in strict.
    // Vitest runs strict; expect throw.
    expect(() => {
      (e.context as Record<string, unknown>)['a'] = 2;
    }).toThrow(TypeError);
  });
});
