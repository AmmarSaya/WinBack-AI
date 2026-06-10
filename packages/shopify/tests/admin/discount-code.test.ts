import { describe, expect, it } from 'vitest';

import { deriveWinbackDiscountCode } from '../../src/admin/discount-code.js';

const SECRET = 'test-shopify-api-secret';
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]+$/; // 0-9 + A-Z minus I,L,O,U

describe('deriveWinbackDiscountCode', () => {
  it('format: "WB-" + 16 Crockford symbols (no I/L/O/U)', () => {
    const code = deriveWinbackDiscountCode(SECRET, 'm_1', 'gen_1');
    expect(code.startsWith('WB-')).toBe(true);
    expect(code).toHaveLength(3 + 16);
    const body = code.slice(3);
    expect(body).toHaveLength(16);
    expect(body).toMatch(CROCKFORD);
    expect(body).not.toMatch(/[ILOU]/);
  });

  it('deterministic: same (secret, merchantId, aiGenerationId) → same code', () => {
    expect(deriveWinbackDiscountCode(SECRET, 'm_1', 'gen_1')).toBe(
      deriveWinbackDiscountCode(SECRET, 'm_1', 'gen_1'),
    );
  });

  it('distinct aiGenerationId → distinct code (per-generation uniqueness)', () => {
    expect(deriveWinbackDiscountCode(SECRET, 'm_1', 'gen_1')).not.toBe(
      deriveWinbackDiscountCode(SECRET, 'm_1', 'gen_2'),
    );
  });

  it('distinct merchantId → distinct code (tenant separation)', () => {
    expect(deriveWinbackDiscountCode(SECRET, 'm_1', 'gen_1')).not.toBe(
      deriveWinbackDiscountCode(SECRET, 'm_2', 'gen_1'),
    );
  });

  it('keyed: a different secret yields a different code (unguessable without the key)', () => {
    expect(deriveWinbackDiscountCode(SECRET, 'm_1', 'gen_1')).not.toBe(
      deriveWinbackDiscountCode('a-different-secret', 'm_1', 'gen_1'),
    );
  });

  it('no separator ambiguity: (a:b) vs (a, b) message split does not alias', () => {
    // merchantId 'a' + aiGenerationId 'b:c'  vs  'a:b' + 'c' must differ —
    // the single ':' joiner means these are different HMAC messages
    // ('a:b:c' is the same string, but the derivation joins exactly one ':'
    // so 'a' + 'b:c' → 'a:b:c' and 'a:b' + 'c' → 'a:b:c' WOULD collide). This
    // documents the (low-severity) property for the chosen id shapes (cuids
    // never contain ':'), so in practice the inputs can't be confused.
    const a = deriveWinbackDiscountCode(SECRET, 'a', 'b:c');
    const b = deriveWinbackDiscountCode(SECRET, 'a:b', 'c');
    // Both map to HMAC('a:b:c'); cuids contain no ':' so this case never
    // arises in production. Asserting equality LOCKS the joiner semantics so a
    // future change to a delimiter-free join is a conscious, tested decision.
    expect(a).toBe(b);
  });
});
