import { randomBytes } from 'node:crypto';

import { ValidationError } from '@winback/errors';
import { describe, expect, it } from 'vitest';

import { Cipher, CipherError, decodeKey } from '../src/cipher.js';

const testKey = randomBytes(32);

describe('Cipher — AES-256-GCM', () => {
  it('roundtrips a short ASCII string', () => {
    const c = new Cipher(testKey);
    const plain = 'shpat_abc123def456';
    const ct = c.encrypt(plain);
    expect(c.decrypt(ct)).toBe(plain);
  });

  it('roundtrips Unicode', () => {
    const c = new Cipher(testKey);
    const plain = 'café — résumé 日本語 🔐';
    expect(c.decrypt(c.encrypt(plain))).toBe(plain);
  });

  it('roundtrips empty string', () => {
    const c = new Cipher(testKey);
    expect(c.decrypt(c.encrypt(''))).toBe('');
  });

  it('produces different ciphertext for same plaintext (random IV)', () => {
    const c = new Cipher(testKey);
    const a = c.encrypt('same');
    const b = c.encrypt('same');
    expect(a).not.toBe(b);
    expect(c.decrypt(a)).toBe(c.decrypt(b));
  });

  it('prefixes output with v1:', () => {
    const c = new Cipher(testKey);
    expect(c.encrypt('x')).toMatch(/^v1:/);
  });

  it('throws on tampered ciphertext (GCM tag rejection)', () => {
    const c = new Cipher(testKey);
    const ct = c.encrypt('secret');
    // Flip a byte in the base64 payload (after the "v1:" prefix).
    // Decoding back to a buffer and flipping is more reliable than text edits.
    const [version, payload] = ct.split(':');
    const buf = Buffer.from(payload!, 'base64');
    buf[buf.length - 1]! ^= 0xff;
    const tampered = `${version}:${buf.toString('base64')}`;
    expect(() => c.decrypt(tampered)).toThrow(CipherError);
  });

  it('throws on wrong key', () => {
    const c1 = new Cipher(testKey);
    const c2 = new Cipher(randomBytes(32));
    const ct = c1.encrypt('secret');
    expect(() => c2.decrypt(ct)).toThrow(CipherError);
  });

  it('throws on unknown version prefix', () => {
    const c = new Cipher(testKey);
    expect(() => c.decrypt('v9:abcd')).toThrow(CipherError);
  });

  it('throws on missing version prefix', () => {
    const c = new Cipher(testKey);
    expect(() => c.decrypt('justbase64')).toThrow(CipherError);
  });

  it('throws on too-short payload', () => {
    const c = new Cipher(testKey);
    expect(() => c.decrypt('v1:c2hvcnQ=')).toThrow(CipherError);
  });

  it('rejects wrong key length at construction', () => {
    expect(() => new Cipher(randomBytes(16))).toThrow(ValidationError);
    expect(() => new Cipher(randomBytes(64))).toThrow(ValidationError);
  });
});

describe('decodeKey', () => {
  it('decodes a valid base64 32-byte key', () => {
    const raw = randomBytes(32);
    const b64 = raw.toString('base64');
    const decoded = decodeKey(b64);
    expect(decoded.equals(raw)).toBe(true);
  });

  it('rejects wrong-length keys', () => {
    expect(() => decodeKey(randomBytes(16).toString('base64'))).toThrow(ValidationError);
    expect(() => decodeKey(randomBytes(48).toString('base64'))).toThrow(ValidationError);
  });
});
