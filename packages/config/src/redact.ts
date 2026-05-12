const SECRET_KEY_PATTERN = /secret|key|token|password|credential|passphrase/i;
const REDACTED = '[REDACTED]';

/**
 * Returns a shallow copy of `obj` with the named fields replaced by
 * `'[REDACTED]'`. Preferred over `redactSecrets` when the sensitive fields
 * are known statically — there is no risk of false negatives.
 *
 * The return type lies (still `T`) because consumers are only ever logging
 * the result; do not feed the output back into typed business logic.
 */
export function redact<T extends Record<string, unknown>>(
  obj: T,
  keys: readonly (keyof T)[],
): T {
  const out: Record<string, unknown> = { ...obj };
  for (const k of keys) {
    if (k in out) {
      out[k as string] = REDACTED;
    }
  }
  return out as T;
}

/**
 * Walks `obj` (recursively into plain objects) and replaces values whose key
 * matches `secret|key|token|password|credential|passphrase` with
 * `'[REDACTED]'`.
 *
 * Heuristic only. False positives are possible (e.g. a benign field named
 * `tokenCount`). For known-sensitive fields, prefer the explicit `redact`.
 * Never rely on this as a security primitive — its sole purpose is to keep
 * boot-time "config loaded" log lines free of obvious secrets.
 */
export function redactSecrets<T extends Record<string, unknown>>(
  obj: T,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEY_PATTERN.test(k)) {
      out[k] = REDACTED;
      continue;
    }
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      out[k] = redactSecrets(v as Record<string, unknown>);
      continue;
    }
    out[k] = v;
  }
  return out;
}
