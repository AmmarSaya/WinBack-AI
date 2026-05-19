import { ValidationError } from '@winback/errors';
import { describe, expect, it } from 'vitest';

import { parseMoneyToCents } from '../src/money.js';

/**
 * Unit tests for `parseMoneyToCents`.
 *
 * The function is a strict regex parser. The failure mode for a wrong
 * regex is `valid Shopify money string → ValidationError → drainer
 * markFailed → operator alerted on a legitimate order`. Production-
 * impacting, and the regex is a one-character-edit risk surface. These
 * tests lock the contract.
 */

describe('parseMoneyToCents — accepts (BigInt cents output)', () => {
  it('integer string with no decimal point: "100" → 10000n', () => {
    expect(parseMoneyToCents('100')).toBe(10000n);
  });

  it('integer string "0" → 0n', () => {
    expect(parseMoneyToCents('0')).toBe(0n);
  });

  it('one decimal place: "100.5" → 10050n', () => {
    expect(parseMoneyToCents('100.5')).toBe(10050n);
  });

  it('two decimal places: "100.95" → 10095n', () => {
    expect(parseMoneyToCents('100.95')).toBe(10095n);
  });

  it('zero with two decimals: "0.00" → 0n', () => {
    expect(parseMoneyToCents('0.00')).toBe(0n);
  });

  it('two-decimal zero pad: "100.05" → 10005n (NOT 10050)', () => {
    // Regression lock: the leading-zero in the decimal portion must be
    // preserved. A naive parser that drops leading zeros from the
    // decimal segment would compute 100*100 + 5 = 10005 by accident,
    // but for the wrong reason. This case forces the right behavior.
    expect(parseMoneyToCents('100.05')).toBe(10005n);
  });

  it('two-decimal value where padEnd is a no-op: "1.99" → 199n', () => {
    expect(parseMoneyToCents('1.99')).toBe(199n);
  });

  it('large number — BigInt math correctness: "9999999999999999.99"', () => {
    // 9999999999999999.99 * 100 = 999999999999999999 (within BigInt range trivially)
    expect(parseMoneyToCents('9999999999999999.99')).toBe(999999999999999999n);
  });

  it('leading-zero integer part accepted: "0123" → 12300n', () => {
    // The regex `^\d+$` permits leading zeros. Shopify shouldn't send
    // these (no canonical reason to), but accepting them matches the
    // documented "no extra ceremony" parsing posture and avoids
    // surprise rejections for legitimate-shaped data.
    expect(parseMoneyToCents('0123')).toBe(12300n);
  });

  it('one-decimal pad: "0.5" → 50n', () => {
    expect(parseMoneyToCents('0.5')).toBe(50n);
  });
});

describe('parseMoneyToCents — rejects (throws ValidationError)', () => {
  it('throws on empty string', () => {
    expect(() => parseMoneyToCents('')).toThrow(ValidationError);
  });

  it('throws on non-numeric input', () => {
    expect(() => parseMoneyToCents('abc')).toThrow(ValidationError);
  });

  it('throws on more than 2 decimal places: "1.123"', () => {
    expect(() => parseMoneyToCents('1.123')).toThrow(ValidationError);
  });

  it('throws on scientific notation: "1e3"', () => {
    expect(() => parseMoneyToCents('1e3')).toThrow(ValidationError);
  });

  it('throws on negative values: "-1.00"', () => {
    expect(() => parseMoneyToCents('-1.00')).toThrow(ValidationError);
  });

  it('throws on bare negative: "-1"', () => {
    expect(() => parseMoneyToCents('-1')).toThrow(ValidationError);
  });

  it('throws on trailing decimal point: "100."', () => {
    expect(() => parseMoneyToCents('100.')).toThrow(ValidationError);
  });

  it('throws on leading decimal point: ".50"', () => {
    expect(() => parseMoneyToCents('.50')).toThrow(ValidationError);
  });

  it('throws on whitespace: " 100" (regex anchors are strict)', () => {
    expect(() => parseMoneyToCents(' 100')).toThrow(ValidationError);
  });

  it('throws on trailing whitespace: "100 "', () => {
    expect(() => parseMoneyToCents('100 ')).toThrow(ValidationError);
  });

  it('throws on non-string input (number)', () => {
    expect(() => parseMoneyToCents(100 as unknown as string)).toThrow(ValidationError);
  });

  it('throws on null input', () => {
    expect(() => parseMoneyToCents(null as unknown as string)).toThrow(ValidationError);
  });

  it('throws on undefined input', () => {
    expect(() => parseMoneyToCents(undefined as unknown as string)).toThrow(ValidationError);
  });

  it('throws on currency-prefixed string: "$100.00"', () => {
    expect(() => parseMoneyToCents('$100.00')).toThrow(ValidationError);
  });

  it('throws on comma thousand separator: "1,000.00"', () => {
    expect(() => parseMoneyToCents('1,000.00')).toThrow(ValidationError);
  });
});
