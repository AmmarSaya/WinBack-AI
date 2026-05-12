import { AppError } from '@winback/errors';
import type { ZodError } from 'zod';

export interface ConfigErrorIssue {
  readonly path: string;
  readonly message: string;
  /**
   * Whether the env variable was present at all. We never include the raw
   * received value — process.env values are unsafe to log (they may contain
   * secrets) even when validation fails.
   */
  readonly received: 'undefined' | 'present';
}

/**
 * Thrown synchronously when env validation fails. Boot-only; do not catch
 * outside the process entry point. Catching it in normal handler code is a
 * sign of a misconfigured module that's evaluating config too late.
 *
 * Extends `AppError` so it integrates with the global taxonomy:
 *   - code: "config.invalid"
 *   - statusCode: 500 (process should die; not a client fault)
 *   - retryable: false (retrying a misconfigured process is pointless)
 *   - exposeMessage: false (config errors are operator-facing, never client-facing)
 */
export class ConfigError extends AppError {
  override readonly name = 'ConfigError';
  readonly issues: readonly ConfigErrorIssue[];

  constructor(message: string, issues: readonly ConfigErrorIssue[]) {
    super({
      code: 'config.invalid',
      message,
      statusCode: 500,
      retryable: false,
      exposeMessage: false,
      context: { issueCount: issues.length },
    });
    this.issues = issues;
  }

  static fromZod(zErr: ZodError, source: NodeJS.ProcessEnv): ConfigError {
    const issues: ConfigErrorIssue[] = zErr.issues.map((issue) => {
      const path = issue.path.join('.');
      const received: ConfigErrorIssue['received'] =
        source[path] === undefined ? 'undefined' : 'present';
      return { path, message: issue.message, received };
    });
    const summary = issues
      .map((i) => `  - ${i.path}: ${i.message} (received: ${i.received})`)
      .join('\n');
    return new ConfigError(
      `Invalid configuration:\n${summary}\n\nFix the corresponding environment variables and restart.`,
      issues,
    );
  }
}
