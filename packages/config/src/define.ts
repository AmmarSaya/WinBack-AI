import type { ZodTypeAny, z } from 'zod';

import { ConfigError } from './error.js';

export interface DefineConfigOptions {
  /**
   * Source of variables. Defaults to `process.env`. Override in tests to
   * isolate config parsing from the host environment.
   */
  readonly source?: NodeJS.ProcessEnv | undefined;
}

/**
 * Parses and validates a slice of environment variables against a zod schema.
 *
 * All `process.env.*` values are strings (or undefined). Use `z.coerce.*`
 * (e.g. `z.coerce.number()`, `z.coerce.boolean()`) for non-string fields —
 * plain `z.number()` will reject every input.
 *
 * Failure throws `ConfigError` synchronously. This is intentional: misconfigured
 * processes must fail at boot, not lazily on first request.
 *
 * This is the ONLY sanctioned mechanism for reading env vars in the workspace.
 * Direct `process.env.X` reads outside this package are an anti-pattern and
 * will eventually be enforced by a lint rule.
 */
export function defineConfig<S extends ZodTypeAny>(
  schema: S,
  options: DefineConfigOptions = {},
): z.infer<S> {
  const source = options.source ?? process.env;
  const result = schema.safeParse(source);
  if (!result.success) {
    throw ConfigError.fromZod(result.error, source);
  }
  return result.data as z.infer<S>;
}
