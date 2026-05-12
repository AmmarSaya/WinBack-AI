import { AppError } from './app-error.js';

export interface SimpleErrorOptions {
  readonly code?: string | undefined;
  readonly cause?: unknown;
  readonly context?: Readonly<Record<string, unknown>> | undefined;
}

// --- Client-facing (4xx, exposeMessage=true) --------------------------------

export interface ValidationErrorOptions {
  readonly code?: string | undefined;
  readonly fields?: Readonly<Record<string, string>> | undefined;
  readonly cause?: unknown;
}

export class ValidationError extends AppError {
  override readonly name = 'ValidationError';
  constructor(message: string, options: ValidationErrorOptions = {}) {
    super({
      code: options.code ?? 'validation.failed',
      message,
      statusCode: 400,
      retryable: false,
      exposeMessage: true,
      cause: options.cause,
      context: options.fields !== undefined ? { fields: options.fields } : undefined,
    });
  }
}

export class UnauthorizedError extends AppError {
  override readonly name = 'UnauthorizedError';
  constructor(message = 'Unauthorized', options: SimpleErrorOptions = {}) {
    super({
      code: options.code ?? 'auth.unauthorized',
      message,
      statusCode: 401,
      retryable: false,
      exposeMessage: true,
      cause: options.cause,
      context: options.context,
    });
  }
}

export class ForbiddenError extends AppError {
  override readonly name = 'ForbiddenError';
  constructor(message = 'Forbidden', options: SimpleErrorOptions = {}) {
    super({
      code: options.code ?? 'auth.forbidden',
      message,
      statusCode: 403,
      retryable: false,
      exposeMessage: true,
      cause: options.cause,
      context: options.context,
    });
  }
}

export class NotFoundError extends AppError {
  override readonly name = 'NotFoundError';
  constructor(message = 'Not found', options: SimpleErrorOptions = {}) {
    super({
      code: options.code ?? 'resource.not_found',
      message,
      statusCode: 404,
      retryable: false,
      exposeMessage: true,
      cause: options.cause,
      context: options.context,
    });
  }
}

export class ConflictError extends AppError {
  override readonly name = 'ConflictError';
  constructor(message: string, options: SimpleErrorOptions = {}) {
    super({
      code: options.code ?? 'resource.conflict',
      message,
      statusCode: 409,
      retryable: false,
      exposeMessage: true,
      cause: options.cause,
      context: options.context,
    });
  }
}

// --- Rate limit / timeout (retryable, message NOT exposed) ------------------

export interface RateLimitErrorOptions {
  readonly code?: string | undefined;
  readonly retryAfterSeconds?: number | undefined;
  readonly cause?: unknown;
  readonly context?: Readonly<Record<string, unknown>> | undefined;
}

export class RateLimitError extends AppError {
  override readonly name = 'RateLimitError';
  readonly retryAfterSeconds: number | undefined;
  constructor(message = 'Rate limited', options: RateLimitErrorOptions = {}) {
    const ctx: Record<string, unknown> = { ...(options.context ?? {}) };
    if (options.retryAfterSeconds !== undefined) {
      ctx['retryAfterSeconds'] = options.retryAfterSeconds;
    }
    super({
      code: options.code ?? 'rate_limit.exceeded',
      message,
      statusCode: 429,
      retryable: true,
      exposeMessage: false,
      cause: options.cause,
      context: ctx,
    });
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export class TimeoutError extends AppError {
  override readonly name = 'TimeoutError';
  constructor(message = 'Operation timed out', options: SimpleErrorOptions = {}) {
    super({
      code: options.code ?? 'timeout.exceeded',
      message,
      statusCode: 504,
      retryable: true,
      exposeMessage: false,
      cause: options.cause,
      context: options.context,
    });
  }
}

// --- Integration / Infrastructure (retryable by default) --------------------

export interface IntegrationErrorOptions {
  readonly code?: string | undefined;
  readonly provider?: string | undefined;
  readonly providerStatus?: number | undefined;
  readonly retryable?: boolean | undefined;
  readonly cause?: unknown;
  readonly context?: Readonly<Record<string, unknown>> | undefined;
}

export class IntegrationError extends AppError {
  // Typed as `string` (not the literal) so subclasses (e.g.,
  // ShopifyTokenExchangeError) can override with their own name literal.
  override readonly name: string = 'IntegrationError';
  readonly provider: string | undefined;
  readonly providerStatus: number | undefined;
  constructor(message: string, options: IntegrationErrorOptions = {}) {
    const ctx: Record<string, unknown> = { ...(options.context ?? {}) };
    if (options.provider !== undefined) ctx['provider'] = options.provider;
    if (options.providerStatus !== undefined) ctx['providerStatus'] = options.providerStatus;
    super({
      code: options.code ?? 'integration.failed',
      message,
      statusCode: 502,
      retryable: options.retryable ?? true,
      exposeMessage: false,
      cause: options.cause,
      context: ctx,
    });
    this.provider = options.provider;
    this.providerStatus = options.providerStatus;
  }
}

export class TransientError extends AppError {
  override readonly name = 'TransientError';
  constructor(message: string, options: SimpleErrorOptions = {}) {
    super({
      code: options.code ?? 'transient.failed',
      message,
      statusCode: 503,
      retryable: true,
      exposeMessage: false,
      cause: options.cause,
      context: options.context,
    });
  }
}

// --- Fatal (intentional terminate, never retry) -----------------------------

export class FatalError extends AppError {
  override readonly name = 'FatalError';
  constructor(message: string, options: SimpleErrorOptions = {}) {
    super({
      code: options.code ?? 'fatal.unrecoverable',
      message,
      statusCode: 500,
      retryable: false,
      exposeMessage: false,
      cause: options.cause,
      context: options.context,
    });
  }
}
