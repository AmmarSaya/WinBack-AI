import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  computeHmacSha256Hex,
  verifyHmacSha256Base64,
  verifyHmacSha256Hex,
} from '../src/hmac.js';

const SECRET = 'test_secret';

function makeHex(msg: string): string {
  return createHmac('sha256', SECRET).update(msg).digest('hex');
}

function makeBase64(msg: string): string {
  return createHmac('sha256', SECRET).update(msg).digest('base64');
}

describe('HMAC-SHA256', () => {
  it('computeHmacSha256Hex matches Node crypto output', () => {
    const msg = 'shop=foo.myshopify.com&timestamp=123';
    expect(computeHmacSha256Hex(SECRET, msg)).toBe(makeHex(msg));
  });
});

describe('verifyHmacSha256Hex', () => {
  it('accepts a matching hex HMAC', () => {
    const msg = 'shop=foo.myshopify.com&timestamp=123';
    expect(verifyHmacSha256Hex(SECRET, msg, makeHex(msg))).toBe(true);
  });

  it('rejects a tampered HMAC', () => {
    const msg = 'shop=foo.myshopify.com';
    const expected = makeHex(msg);
    // Flip one nibble
    const tampered = expected.slice(0, -1) + (expected.endsWith('0') ? '1' : '0');
    expect(verifyHmacSha256Hex(SECRET, msg, tampered)).toBe(false);
  });

  it('rejects a tampered message', () => {
    const expected = makeHex('a=1');
    expect(verifyHmacSha256Hex(SECRET, 'a=2', expected)).toBe(false);
  });

  it('rejects wrong-length expected (no exception)', () => {
    expect(verifyHmacSha256Hex(SECRET, 'a=1', 'short')).toBe(false);
  });

  it('rejects non-hex expected (no exception)', () => {
    expect(verifyHmacSha256Hex(SECRET, 'a=1', 'not-hex!!')).toBe(false);
  });
});

describe('verifyHmacSha256Base64', () => {
  it('accepts a matching base64 HMAC', () => {
    const msg = '{"order":{"id":1}}';
    expect(verifyHmacSha256Base64(SECRET, msg, makeBase64(msg))).toBe(true);
  });

  it('rejects a tampered base64 HMAC', () => {
    const msg = '{"order":{"id":1}}';
    const expected = makeBase64(msg);
    const tampered = expected.slice(0, -1) + (expected.endsWith('A') ? 'B' : 'A');
    expect(verifyHmacSha256Base64(SECRET, msg, tampered)).toBe(false);
  });

  it('accepts Buffer message inputs', () => {
    const msg = Buffer.from('{"a":1}', 'utf8');
    expect(verifyHmacSha256Base64(SECRET, msg, makeBase64('{"a":1}'))).toBe(true);
  });

  it('rejects non-base64 expected (no exception)', () => {
    expect(verifyHmacSha256Base64(SECRET, 'a=1', '!!!')).toBe(false);
  });
});
