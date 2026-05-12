import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * CSRF state-cookie management for the Shopify OAuth flow.
 *
 * C1 deliberately left state management to C2 (`buildAuthRedirectUrl` is
 * pure — no storage). This module owns:
 *
 *   - Generating a random state + signed cookie at `/auth`.
 *   - Verifying the cookie at `/auth/callback` BEFORE token exchange.
 *
 * The cookie value format:
 *
 *     <base64url(JSON.stringify({state, shop, exp}))>.<base64url(hmac-sha256(payload, secret))>
 *
 * Verification order matters: we MUST verify the HMAC signature BEFORE
 * `JSON.parse`-ing the payload. Otherwise an attacker who can control the
 * cookie value (which they cannot, since it's HttpOnly, but defense in
 * depth) could exploit parse-time bugs.
 *
 * Functions accept `secret` as a parameter — they're pure and testable
 * without loading config. Route handlers pass
 * `getShopifyConfig().SHOPIFY_API_SECRET`.
 */

export const STATE_COOKIE_NAME = 'winback_auth_state';
export const STATE_TTL_SECONDS = 5 * 60; // 5 minutes — install flows are quick

export interface StateRecord {
  readonly state: string;
  readonly shop: string;
  /** Unix milliseconds. */
  readonly exp: number;
}

export interface GenerateStateResult {
  readonly state: string;
  readonly cookieHeader: string;
}

export type VerifyStateFailReason =
  | 'missing_cookie'
  | 'malformed_cookie'
  | 'invalid_signature'
  | 'invalid_payload'
  | 'expired'
  | 'shop_mismatch'
  | 'state_mismatch';

export type VerifyStateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: VerifyStateFailReason };

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function encodeRecord(record: StateRecord): string {
  return Buffer.from(JSON.stringify(record), 'utf8').toString('base64url');
}

function decodeRecord(b64: string): StateRecord | null {
  try {
    const json = Buffer.from(b64, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['state'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['shop'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['exp'] === 'number'
    ) {
      const obj = parsed as { state: string; shop: string; exp: number };
      return { state: obj.state, shop: obj.shop, exp: obj.exp };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cookie serialization
// ---------------------------------------------------------------------------

export function serializeStateCookie(record: StateRecord, secret: string): string {
  const payload = encodeRecord(record);
  const sig = sign(payload, secret);
  return (
    `${STATE_COOKIE_NAME}=${payload}.${sig};` +
    ` Path=/;` +
    ` HttpOnly;` +
    ` Secure;` +
    ` SameSite=Lax;` +
    ` Max-Age=${String(STATE_TTL_SECONDS)}`
  );
}

export function clearStateCookie(): string {
  return `${STATE_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// ---------------------------------------------------------------------------
// Cookie parsing
// ---------------------------------------------------------------------------

function findCookieValue(cookieHeader: string): string | null {
  const prefix = `${STATE_COOKIE_NAME}=`;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return null;
}

function parseAndVerifyCookie(
  cookieValue: string,
  secret: string,
): { ok: true; record: StateRecord } | { ok: false; reason: VerifyStateFailReason } {
  const dotIdx = cookieValue.lastIndexOf('.');
  if (dotIdx < 0) return { ok: false, reason: 'malformed_cookie' };

  const payload = cookieValue.slice(0, dotIdx);
  const sig = cookieValue.slice(dotIdx + 1);
  const expectedSig = sign(payload, secret);

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) {
    return { ok: false, reason: 'invalid_signature' };
  }
  if (!timingSafeEqual(sigBuf, expectedBuf)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  // Signature verified — only NOW do we parse the payload.
  const record = decodeRecord(payload);
  if (record === null) {
    return { ok: false, reason: 'invalid_payload' };
  }
  return { ok: true, record };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function generateState(shop: string, secret: string, now: number = Date.now()): GenerateStateResult {
  const state = randomBytes(32).toString('base64url');
  const record: StateRecord = { state, shop, exp: now + STATE_TTL_SECONDS * 1000 };
  return { state, cookieHeader: serializeStateCookie(record, secret) };
}

export function verifyState(
  cookieHeader: string | null,
  callbackState: string,
  callbackShop: string,
  secret: string,
  now: number = Date.now(),
): VerifyStateResult {
  if (cookieHeader === null || cookieHeader.length === 0) {
    return { ok: false, reason: 'missing_cookie' };
  }
  const cookieValue = findCookieValue(cookieHeader);
  if (cookieValue === null) {
    return { ok: false, reason: 'missing_cookie' };
  }

  const parsed = parseAndVerifyCookie(cookieValue, secret);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  const { record } = parsed;

  if (record.exp < now) return { ok: false, reason: 'expired' };
  if (record.shop !== callbackShop) return { ok: false, reason: 'shop_mismatch' };

  const a = Buffer.from(record.state);
  const b = Buffer.from(callbackState);
  if (a.length !== b.length) return { ok: false, reason: 'state_mismatch' };
  if (!timingSafeEqual(a, b)) return { ok: false, reason: 'state_mismatch' };

  return { ok: true };
}
