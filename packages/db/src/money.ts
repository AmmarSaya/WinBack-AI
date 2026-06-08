import { ValidationError } from '@winback/errors';

/**
 * Parse a Shopify money string (e.g. "199.95") into BigInt cents.
 *
 * Strict per EPIC-E-FIELD-MAPPING.md P-2:
 *   - Rejects non-string input
 *   - Rejects scientific notation ("1e3") — Shopify never uses it; if seen,
 *     treat as contract violation
 *   - Rejects more than 2 decimal places — Shopify's pricing precision is
 *     cents; sub-cent values shouldn't appear
 *   - Rejects negative values — money columns are unsigned BigInt; refunds
 *     and discounts arrive on separate columns / events
 *   - Accepts integer values without decimal ("100" → 10000n)
 *   - Accepts 1 or 2 decimal places ("100.5" → 10050n, "100.95" → 10095n)
 *
 * Failure mode: throws `ValidationError` (non-retryable per
 * `@winback/errors`). In the drainer's per-row try/catch, this leads to
 * markDeadLettered → operator-visible DLQ. The locked policy for
 * money-format violations is "alert operator, do not silently round."
 *
 * Lives in `@winback/db` rather than `@winback/shopify` because BigInt
 * cents is a database-layer concern per locked architectural decision #2
 * (see ARCHITECTURE.md). The Shopify Zod schemas validate that the value
 * is a string; this function does the strict format check + conversion at
 * the database boundary.
 */

const MONEY_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;

export function parseMoneyToCents(value: string): bigint {
  if (typeof value !== 'string') {
    throw new ValidationError(
      `parseMoneyToCents: expected string, got ${typeof value}`,
      { code: 'money.invalid_type' },
    );
  }
  const match = MONEY_PATTERN.exec(value);
  if (match === null) {
    throw new ValidationError(
      `parseMoneyToCents: malformed money string ${JSON.stringify(value)}`,
      {
        code: 'money.invalid_format',
        fields: { received: value },
      },
    );
  }
  const intPart = match[1];
  if (intPart === undefined) {
    // Unreachable today — MONEY_PATTERN's first capture group `(\d+)` is
    // required, and a non-null `match` guarantees `match[1]` is defined.
    // Kept as a real guard against a future edit that makes capture 1
    // optional: without this branch, an undefined intPart would silently
    // flow into `BigInt(undefined)` and throw or corrupt the parse on a
    // financial-data path. Cheap insurance.
    throw new ValidationError(
      `parseMoneyToCents: regex matched but capture 1 missing for ${JSON.stringify(value)}`,
      {
        code: 'money.invalid_format',
        fields: { received: value },
      },
    );
  }
  // Pad with trailing zeros so "100" → "00", "100.5" → "50", "100.95" → "95".
  const decPart = (match[2] ?? '').padEnd(2, '0').slice(0, 2);
  return BigInt(intPart) * 100n + BigInt(decPart);
}
