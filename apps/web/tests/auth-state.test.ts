import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  STATE_COOKIE_NAME,
  STATE_TTL_SECONDS,
  clearStateCookie,
  generateState,
  serializeStateCookie,
  verifyState,
} from '../app/services/auth-state.server.js';

const SECRET = 'test_secret_at_least_long_enough_for_hmac_safety';
const SHOP = 'foo.myshopify.com';

function extractCookieValue(setCookieHeader: string): string {
  const eq = setCookieHeader.indexOf('=');
  const semi = setCookieHeader.indexOf(';');
  return setCookieHeader.slice(eq + 1, semi);
}

function cookieHeaderFor(value: string): string {
  return `${STATE_COOKIE_NAME}=${value}`;
}

describe('auth-state CSRF cookie', () => {
  it('roundtrips: generate → verify', () => {
    const { state, cookieHeader } = generateState(SHOP, SECRET);
    const value = extractCookieValue(cookieHeader);
    const result = verifyState(cookieHeaderFor(value), state, SHOP, SECRET);
    expect(result.ok).toBe(true);
  });

  it('emits a HttpOnly + Secure + SameSite=Lax cookie', () => {
    const { cookieHeader } = generateState(SHOP, SECRET);
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('Secure');
    expect(cookieHeader).toContain('SameSite=Lax');
    expect(cookieHeader).toContain(`Max-Age=${String(STATE_TTL_SECONDS)}`);
  });

  it('rejects null cookie header', () => {
    const result = verifyState(null, 'state', SHOP, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_cookie');
  });

  it('rejects empty cookie header', () => {
    const result = verifyState('', 'state', SHOP, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_cookie');
  });

  it('rejects cookie header missing our cookie', () => {
    const result = verifyState('other_cookie=value', 'state', SHOP, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_cookie');
  });

  it('rejects tampered signature (one bit flip)', () => {
    const { state, cookieHeader } = generateState(SHOP, SECRET);
    const value = extractCookieValue(cookieHeader);
    const dotIdx = value.lastIndexOf('.');
    const payload = value.slice(0, dotIdx);
    const sig = value.slice(dotIdx + 1);
    // Flip the last character of the signature.
    const tamperedSig = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    const result = verifyState(
      cookieHeaderFor(`${payload}.${tamperedSig}`),
      state,
      SHOP,
      SECRET,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_signature');
  });

  it('rejects malformed cookie without a dot separator', () => {
    const result = verifyState(cookieHeaderFor('no-dot-here'), 'state', SHOP, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed_cookie');
  });

  it('rejects expired record', () => {
    const past = Date.now() - 10 * 60 * 1000;
    const { state, cookieHeader } = generateState(SHOP, SECRET, past);
    const value = extractCookieValue(cookieHeader);
    const result = verifyState(cookieHeaderFor(value), state, SHOP, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('rejects shop mismatch (CSRF + tenant-spoof protection)', () => {
    const { state, cookieHeader } = generateState(SHOP, SECRET);
    const value = extractCookieValue(cookieHeader);
    const result = verifyState(
      cookieHeaderFor(value),
      state,
      'evil.myshopify.com',
      SECRET,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('shop_mismatch');
  });

  it('rejects state mismatch (replay)', () => {
    const { cookieHeader } = generateState(SHOP, SECRET);
    const value = extractCookieValue(cookieHeader);
    const result = verifyState(cookieHeaderFor(value), 'wrong_state', SHOP, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('state_mismatch');
  });

  it('rejects when secret has rotated', () => {
    const { state, cookieHeader } = generateState(SHOP, SECRET);
    const value = extractCookieValue(cookieHeader);
    const result = verifyState(cookieHeaderFor(value), state, SHOP, 'different_secret');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_signature');
  });

  it('rejects invalid payload after valid signature (defense in depth)', () => {
    // Construct a cookie where the signature matches but the payload is
    // not a valid JSON-encoded StateRecord.
    const garbagePayload = Buffer.from('not json at all', 'utf8').toString('base64url');
    const sig = createHmac('sha256', SECRET).update(garbagePayload).digest('base64url');
    const result = verifyState(
      cookieHeaderFor(`${garbagePayload}.${sig}`),
      'state',
      SHOP,
      SECRET,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_payload');
  });

  it('clearStateCookie emits a deletion header', () => {
    const header = clearStateCookie();
    expect(header).toContain(`${STATE_COOKIE_NAME}=`);
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('HttpOnly');
  });

  it('serializeStateCookie produces parseable output', () => {
    const record = { state: 'abc', shop: SHOP, exp: Date.now() + 60_000 };
    const header = serializeStateCookie(record, SECRET);
    const value = extractCookieValue(header);
    const result = verifyState(cookieHeaderFor(value), 'abc', SHOP, SECRET);
    expect(result.ok).toBe(true);
  });

  it('cookie payloads are independent across calls (random state)', () => {
    const a = generateState(SHOP, SECRET);
    const b = generateState(SHOP, SECRET);
    expect(a.state).not.toBe(b.state);
    expect(a.cookieHeader).not.toBe(b.cookieHeader);
  });
});
