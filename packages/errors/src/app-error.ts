export interface AppErrorOptions {
  /**
   * Stable dotted identifier (e.g. "validation.failed").
   * Used by log aggregators for grouping/alerting. Append-only — never rename
   * a code after launch.
   */
  readonly code: string;
  readonly message: string;
  /** HTTP-ish 3-digit status. Subclasses set this; callers rarely override. */
  readonly statusCode?: number | undefined;
  /** Whether queue workers should retry the failing work item. */
  readonly retryable?: boolean | undefined;
  /** Underlying cause, preserved via ES2022 `Error.cause`. */
  readonly cause?: unknown;
  /** Safe-to-log metadata. NEVER put secrets here. */
  readonly context?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Whether `message` is safe to return to clients in HTTP bodies.
   * Defaults to `false`. Client-facing subclasses opt in.
   */
  readonly exposeMessage?: boolean | undefined;
}

const DEFAULT_STATUS = 500;
const DEFAULT_RETRYABLE = false;
const DEFAULT_EXPOSE = false;

/**
 * Base error for every fault in the workspace.
 *
 * Subclasses set sensible defaults for statusCode / retryable / exposeMessage
 * and accept caller overrides. Direct `new AppError({...})` use is permitted
 * but a subclass usually expresses intent better.
 */
export class AppError extends Error {
  override readonly name: string = 'AppError';
  readonly code: string;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, unknown>>;
  readonly exposeMessage: boolean;

  constructor(options: AppErrorOptions) {
    super(
      options.message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.code = options.code;
    this.statusCode = options.statusCode ?? DEFAULT_STATUS;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE;
    this.context = Object.freeze({ ...(options.context ?? {}) });
    this.exposeMessage = options.exposeMessage ?? DEFAULT_EXPOSE;
  }
}
