import { isAppError } from './classify.js';

export interface HttpErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId?: string;
    readonly fields?: Readonly<Record<string, string>>;
  };
}

export interface ToHttpOptions {
  readonly requestId?: string | undefined;
  /**
   * Generic message used when the error is not safe to expose
   * (`exposeMessage` defaulted to `false`). Defaults to "Internal server error".
   */
  readonly safeMessage?: string | undefined;
}

const GENERIC_MESSAGE = 'Internal server error';
const UNKNOWN_CODE = 'internal.unknown';

/**
 * Serializes any thrown value into an HTTP response envelope. Never leaks
 * internal messages unless the error explicitly opted in via
 * `exposeMessage: true`.
 *
 * The HTTP layer (Remix actions / loaders, webhook handlers) should be the
 * only place this is called — internal callers throw, they never serialize.
 */
export function toHttp(
  error: unknown,
  options: ToHttpOptions = {},
): { status: number; body: HttpErrorBody } {
  if (isAppError(error)) {
    const message = error.exposeMessage
      ? error.message
      : (options.safeMessage ?? GENERIC_MESSAGE);

    const fields = error.context['fields'];
    const fieldsPart =
      typeof fields === 'object' && fields !== null
        ? { fields: fields as Readonly<Record<string, string>> }
        : {};

    const body: HttpErrorBody = {
      error: {
        code: error.code,
        message,
        ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
        ...fieldsPart,
      },
    };
    return { status: error.statusCode, body };
  }

  const body: HttpErrorBody = {
    error: {
      code: UNKNOWN_CODE,
      message: options.safeMessage ?? GENERIC_MESSAGE,
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    },
  };
  return { status: 500, body };
}
