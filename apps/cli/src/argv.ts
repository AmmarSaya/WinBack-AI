/**
 * Bare argv parsing helpers for the operator CLI.
 *
 * Avoids a commander/yargs dep for D4's two-subcommand scope. The helpers
 * are pure functions, easily unit-tested. Each surfaces user errors with
 * a clear message; the entry script maps to exit code 1.
 *
 * Subcommand routing is a literal switch in the entry — no library needed.
 */

export interface ArgvError {
  readonly kind: 'argv_error';
  readonly message: string;
}

export type ArgvResult<T> = { ok: true; value: T } | { ok: false; error: ArgvError };

/**
 * Returns the positional argument at `index` (0-indexed within the post-
 * subcommand slice). `null` if missing.
 */
export function getPositional(args: readonly string[], index: number): string | null {
  // First non-flag token at-or-after `index`. We skip flag values so that
  // `replay <id> --reason "..."` and `replay --reason "..." <id>` both work.
  let positionalCount = 0;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) continue;
    if (token.startsWith('--')) {
      // Skip the flag value (next token), unless this flag has no value
      // (we don't have boolean flags in D4).
      i += 1;
      continue;
    }
    if (positionalCount === index) return token;
    positionalCount += 1;
  }
  return null;
}

/**
 * Returns the value following `--<flagName>`. `null` if the flag is
 * absent or has no value following it.
 *
 * `--reason "operator note"` → value = "operator note"
 * `--reason` (no value)      → null
 * `--reason=foo`             → null (D4 doesn't support the equals form;
 *                                    keep parser simple)
 */
export function getFlag(args: readonly string[], flagName: string): string | null {
  const flagToken = `--${flagName}`;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flagToken) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) return null;
      return next;
    }
  }
  return null;
}

/**
 * Required-flag helper. Returns a typed error on absence.
 */
export function getRequiredFlag(
  args: readonly string[],
  flagName: string,
): ArgvResult<string> {
  const value = getFlag(args, flagName);
  if (value === null || value.length === 0) {
    return {
      ok: false,
      error: { kind: 'argv_error', message: `Missing required flag --${flagName}` },
    };
  }
  return { ok: true, value };
}

/**
 * Required-positional helper. Returns a typed error on absence.
 */
export function getRequiredPositional(
  args: readonly string[],
  index: number,
  name: string,
): ArgvResult<string> {
  const value = getPositional(args, index);
  if (value === null) {
    return {
      ok: false,
      error: { kind: 'argv_error', message: `Missing required positional argument <${name}>` },
    };
  }
  return { ok: true, value };
}
