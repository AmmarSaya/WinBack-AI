import { AppError } from '@winback/errors';

/**
 * Thrown when a database operation occurs without an active tenant or system
 * scope, or when the operation's `merchantId` disagrees with the active
 * tenant scope.
 *
 * This is a SECURITY error class — it fires before any query reaches the DB,
 * and a `TenantScopeError` in production logs indicates a missing scope
 * boundary or a cross-tenant access attempt. Treat as P1.
 */
export class TenantScopeError extends AppError {
  override readonly name = 'TenantScopeError';
  constructor(
    message: string,
    options: { cause?: unknown; context?: Readonly<Record<string, unknown>> } = {},
  ) {
    super({
      code: 'db.tenant_scope_violation',
      message,
      statusCode: 500,
      retryable: false,
      exposeMessage: false,
      cause: options.cause,
      context: options.context,
    });
  }
}
