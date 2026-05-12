import { AppError } from './app-error.js';

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Whether the error falls in the HTTP 4xx range. Useful for log levels:
 * warn for client errors, error for server errors.
 */
export function isClientError(error: unknown): boolean {
  return isAppError(error) && error.statusCode >= 400 && error.statusCode < 500;
}

export function isServerError(error: unknown): boolean {
  if (!isAppError(error)) return true;
  return error.statusCode >= 500;
}

/**
 * Whether a queue worker / retry loop should retry this error.
 *
 *   - Known AppError → uses its `retryable` flag.
 *   - Unknown error  → `true`. Bounded retry attempts at the BullMQ level are
 *                      the safety net; losing work on an unexpected fault is
 *                      worse than a small number of additional attempts.
 *
 * Callers may still impose their own caps (e.g. permanent failure after N
 * attempts regardless of `retryable`).
 */
export function isRetryable(error: unknown): boolean {
  if (isAppError(error)) return error.retryable;
  return true;
}

export interface FromUnknownDefaults {
  readonly code?: string | undefined;
  readonly message?: string | undefined;
  readonly statusCode?: number | undefined;
  readonly retryable?: boolean | undefined;
}

/**
 * Coerces any thrown value into an AppError, preserving the original via
 * `cause`. Use at trust boundaries (HTTP handlers, queue processors) where
 * you need a uniform error shape downstream.
 */
export function fromUnknown(error: unknown, defaults: FromUnknownDefaults = {}): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) {
    return new AppError({
      code: defaults.code ?? 'internal.unknown',
      message: defaults.message ?? error.message,
      statusCode: defaults.statusCode ?? 500,
      retryable: defaults.retryable ?? true,
      cause: error,
    });
  }
  return new AppError({
    code: defaults.code ?? 'internal.unknown',
    message: defaults.message ?? 'Unknown error',
    statusCode: defaults.statusCode ?? 500,
    retryable: defaults.retryable ?? true,
    cause: error,
  });
}

export interface WrapOptions {
  readonly code: string;
  readonly message: string;
  readonly statusCode?: number | undefined;
  readonly retryable?: boolean | undefined;
  readonly context?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Re-throws as a new AppError, attaching the original via `cause`. Use when
 * you need to reclassify an upstream error (e.g. a Prisma constraint
 * exception into a `ConflictError`, or a Shopify 401 into a domain
 * `UnauthorizedError`).
 */
export function wrap(error: unknown, options: WrapOptions): AppError {
  return new AppError({
    code: options.code,
    message: options.message,
    statusCode: options.statusCode,
    retryable: options.retryable,
    cause: error,
    context: options.context,
  });
}
