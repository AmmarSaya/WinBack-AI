import { describe, expect, it } from 'vitest';

import { encodeCrockfordBase32 } from '../src/base32.js';

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

describe('encodeCrockfordBase32', () => {
  it('empty input → empty string', () => {
    expect(encodeCrockfordBase32(Buffer.alloc(0))).toBe('');
  });

  it('single 0x00 byte → "00" (8 bits = one full symbol + 3 left-aligned zero bits)', () => {
    expect(encodeCrockfordBase32(Buffer.from([0x00]))).toBe('00');
  });

  it('single 0xff byte → "ZW" (11111 then 111 left-aligned to 11100)', () => {
    // 0xFF = 11111111. First symbol 11111 = 31 = 'Z'. Trailing 111 → 11100 = 28 = 'W'.
    expect(encodeCrockfordBase32(Buffer.from([0xff]))).toBe('ZW');
  });

  it('multi-byte vector "He" → "91JG" (hand-computed bit stream)', () => {
    // 0x48,0x65 = 0100100001100101 → 01001|00001|10010|1(000) → 9,1,18,16 → '9','1','J','G'.
    expect(encodeCrockfordBase32(Buffer.from('He', 'ascii'))).toBe('91JG');
  });

  it('output length is ceil(bytes * 8 / 5)', () => {
    // 32 bytes (an HMAC-SHA256 digest) → ceil(256 / 5) = 52 symbols.
    const digest = Buffer.alloc(32, 0xab);
    expect(encodeCrockfordBase32(digest)).toHaveLength(52);
    // 10 bytes → ceil(80 / 5) = 16 symbols (the discount-code truncation width).
    expect(encodeCrockfordBase32(Buffer.alloc(10, 0x01))).toHaveLength(16);
  });

  it('emits only Crockford-alphabet symbols — never the excluded I/L/O/U', () => {
    // Exercise every byte value so all 32 symbols can appear.
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const out = encodeCrockfordBase32(all);
    for (const ch of out) {
      expect(CROCKFORD_ALPHABET).toContain(ch);
    }
    expect(out).not.toMatch(/[ILOU]/);
  });

  it('is deterministic — same input yields the same output', () => {
    const input = Buffer.from('deterministic-input', 'ascii');
    expect(encodeCrockfordBase32(input)).toBe(encodeCrockfordBase32(input));
  });

  it('does not overflow on long inputs (accumulator stays masked)', () => {
    // 256 bytes: if the accumulator weren't masked, JS 32-bit bitwise ops
    // would corrupt the stream. Assert a stable, full-length, in-alphabet result.
    const long = Buffer.alloc(256, 0x7f);
    const out = encodeCrockfordBase32(long);
    expect(out).toHaveLength(Math.ceil((256 * 8) / 5));
    expect(out).toMatch(/^[0-9A-Z]+$/);
    expect(out).not.toMatch(/[ILOU]/);
  });
});
