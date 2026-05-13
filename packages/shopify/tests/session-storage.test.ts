/**
 * Unit tests for EncryptedSessionStorage (the AES-256-GCM decorator over
 * `@shopify/shopify-app-session-storage`).
 *
 * The decorator's job is exactly two things:
 *   1. Encrypt `session.accessToken` on the way down (storeSession).
 *   2. Decrypt `session.accessToken` on the way up (loadSession +
 *      findSessionsByShop).
 *
 * Tests use a hand-rolled in-memory `SessionStorage` mock as the inner
 * adapter, paired with a REAL `Cipher`. That setup gives us a true
 * round-trip property: store-then-load must return the plaintext
 * accessToken that was originally passed in. The mock captures whatever
 * the decorator passed to the inner adapter, so we can also assert
 * "the DB column never sees plaintext" — the user-visible safety
 * invariant of the encryption layer.
 *
 * The inner adapter's own behavior (Prisma upsert / findUnique / etc.)
 * is integration-tested against real Postgres in the package's own
 * test suite; we trust it here. What we're verifying is the wrapping
 * contract.
 */

import { Session } from '@shopify/shopify-api';
import type { SessionStorage } from '@shopify/shopify-app-session-storage';
import { Cipher, decodeKey } from '@winback/crypto';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { EncryptedSessionStorage } from '../src/session-storage.js';

// Base64-encoded 32-byte key for AES-256-GCM (the cipher spec; the same
// length the production ENCRYPTION_KEY satisfies). Generated per-test
// run so a leaked key can never persist across tests.
function makeKey(): string {
  return randomBytes(32).toString('base64');
}

function makeCipher(): Cipher {
  return new Cipher(decodeKey(makeKey()));
}

/**
 * In-memory inner adapter: a `Map<id, Session>` storing whatever the
 * decorator handed in. We use this both to drive the decorator and to
 * inspect the stored shape (verifying ciphertext-not-plaintext).
 */
function makeInner(): SessionStorage & { rows: Map<string, Session> } {
  const rows = new Map<string, Session>();
  return {
    rows,
    async storeSession(session) {
      rows.set(session.id, session);
      return true;
    },
    async loadSession(id) {
      return rows.get(id);
    },
    async deleteSession(id) {
      rows.delete(id);
      return true;
    },
    async deleteSessions(ids) {
      for (const id of ids) rows.delete(id);
      return true;
    },
    async findSessionsByShop(shop) {
      return [...rows.values()].filter((s) => s.shop === shop);
    },
  };
}

function makeOfflineSession(id: string, shop: string, accessToken: string): Session {
  return new Session({
    id,
    shop,
    state: 'state-xyz',
    isOnline: false,
    scope: 'read_customers,read_orders',
    accessToken,
  });
}

// ===========================================================================
// Round-trip — the load-bearing contract
// ===========================================================================

describe('EncryptedSessionStorage — round-trip', () => {
  it('store(plaintext) then load returns plaintext (end-to-end through encrypt+decrypt)', async () => {
    const inner = makeInner();
    const cipher = makeCipher();
    const storage = new EncryptedSessionStorage(inner, cipher);

    const session = makeOfflineSession(
      'offline_foo.myshopify.com',
      'foo.myshopify.com',
      'shopify_offline_access_token_plaintext_xyz',
    );

    await storage.storeSession(session);
    const loaded = await storage.loadSession('offline_foo.myshopify.com');

    expect(loaded).toBeDefined();
    expect(loaded!.accessToken).toBe('shopify_offline_access_token_plaintext_xyz');
    // And the loaded value is still a Session class instance (methods
    // preserved — the SDK's Authentication flow needs `isActive` etc.).
    expect(loaded!.isActive).toBeInstanceOf(Function);
    expect(loaded!.toObject).toBeInstanceOf(Function);
  });

  it('does NOT mutate the caller-supplied Session on storeSession', async () => {
    const inner = makeInner();
    const cipher = makeCipher();
    const storage = new EncryptedSessionStorage(inner, cipher);

    const session = makeOfflineSession('offline_foo', 'foo.myshopify.com', 'plaintext-original');
    await storage.storeSession(session);

    // Caller's instance still has plaintext — the decorator cloned via
    // toObject() rather than mutating.
    expect(session.accessToken).toBe('plaintext-original');
  });

  it('inner adapter sees CIPHERTEXT only, never plaintext', async () => {
    // The on-disk safety invariant: even if someone bypasses the
    // decorator at read time, they only get ciphertext from the inner
    // adapter's stored row.
    const inner = makeInner();
    const cipher = makeCipher();
    const storage = new EncryptedSessionStorage(inner, cipher);

    const plaintext = 'shopify_offline_access_token_secret_value';
    const session = makeOfflineSession('offline_foo', 'foo.myshopify.com', plaintext);

    await storage.storeSession(session);

    const stored = inner.rows.get('offline_foo');
    expect(stored).toBeDefined();
    expect(stored!.accessToken).toBeDefined();
    expect(stored!.accessToken).not.toBe(plaintext); // ciphertext ≠ plaintext
    expect(stored!.accessToken!.startsWith('v1:')).toBe(true); // our Cipher format marker
  });
});

// ===========================================================================
// Token-absent paths
// ===========================================================================

describe('EncryptedSessionStorage — token-absent paths', () => {
  it('storeSession with undefined accessToken delegates without encryption', async () => {
    const inner = makeInner();
    const cipher = makeCipher();
    const storage = new EncryptedSessionStorage(inner, cipher);

    // SDK Session: omit accessToken from constructor.
    const session = new Session({
      id: 'offline_foo',
      shop: 'foo.myshopify.com',
      state: 'state-xyz',
      isOnline: false,
    });
    await storage.storeSession(session);

    const stored = inner.rows.get('offline_foo');
    expect(stored!.accessToken).toBeUndefined();
  });

  it('loadSession of a session with empty-string accessToken returns it unchanged (no decrypt attempt)', async () => {
    const inner = makeInner();
    const cipher = makeCipher();
    const storage = new EncryptedSessionStorage(inner, cipher);

    // Seed inner directly with a token-less row (simulates the adapter's
    // `accessToken: ''` default when sessionParams.accessToken was absent).
    inner.rows.set(
      'offline_foo',
      new Session({
        id: 'offline_foo',
        shop: 'foo.myshopify.com',
        state: 'state-xyz',
        isOnline: false,
        accessToken: '',
      }),
    );

    const loaded = await storage.loadSession('offline_foo');
    expect(loaded).toBeDefined();
    expect(loaded!.accessToken).toBe('');
  });
});

// ===========================================================================
// Corrupt-ciphertext defense
// ===========================================================================

describe('EncryptedSessionStorage — corrupt ciphertext', () => {
  it('drops accessToken (returns undefined on the field) when decrypt fails', async () => {
    const inner = makeInner();
    const cipher = makeCipher();
    const storage = new EncryptedSessionStorage(inner, cipher);

    // Seed inner with garbage in the accessToken slot — simulates a
    // wrong-key situation or DB corruption.
    inner.rows.set(
      'offline_foo',
      new Session({
        id: 'offline_foo',
        shop: 'foo.myshopify.com',
        state: 'state-xyz',
        isOnline: false,
        accessToken: 'v1:obviously-not-valid-base64-ciphertext!!',
      }),
    );

    const loaded = await storage.loadSession('offline_foo');
    expect(loaded).toBeDefined();
    // Decrypt failed → token dropped (caller will surface re-auth).
    // Critical: we do NOT throw, because that would break login flows
    // for valid-but-old sessions during a key rotation event.
    expect(loaded!.accessToken).toBeUndefined();
  });
});

// ===========================================================================
// findSessionsByShop
// ===========================================================================

describe('EncryptedSessionStorage — findSessionsByShop', () => {
  it('decrypts each returned session in place', async () => {
    const inner = makeInner();
    const cipher = makeCipher();
    const storage = new EncryptedSessionStorage(inner, cipher);

    await storage.storeSession(
      makeOfflineSession('offline_foo', 'foo.myshopify.com', 'token-a'),
    );
    await storage.storeSession(
      makeOfflineSession('online_foo_42', 'foo.myshopify.com', 'token-b'),
    );
    await storage.storeSession(
      makeOfflineSession('offline_bar', 'bar.myshopify.com', 'token-c'),
    );

    const found = await storage.findSessionsByShop('foo.myshopify.com');
    expect(found).toHaveLength(2);
    const tokens = found.map((s) => s.accessToken).sort();
    expect(tokens).toEqual(['token-a', 'token-b']);
  });

  it('returns empty array when no sessions match (pass-through)', async () => {
    const inner = makeInner();
    const cipher = makeCipher();
    const storage = new EncryptedSessionStorage(inner, cipher);

    const found = await storage.findSessionsByShop('absent.myshopify.com');
    expect(found).toEqual([]);
  });
});

// ===========================================================================
// Delete pass-through
// ===========================================================================

describe('EncryptedSessionStorage — delete operations', () => {
  it('deleteSession delegates to inner adapter', async () => {
    const inner = makeInner();
    const storage = new EncryptedSessionStorage(inner, makeCipher());

    await storage.storeSession(
      makeOfflineSession('offline_foo', 'foo.myshopify.com', 'token'),
    );
    expect(inner.rows.size).toBe(1);

    await storage.deleteSession('offline_foo');
    expect(inner.rows.size).toBe(0);
  });

  it('deleteSessions short-circuits on empty array (skips adapter call)', async () => {
    let called = 0;
    const inner: SessionStorage = {
      ...makeInner(),
      async deleteSessions() {
        called += 1;
        return true;
      },
    };
    const storage = new EncryptedSessionStorage(inner, makeCipher());

    await storage.deleteSessions([]);
    expect(called).toBe(0);
  });

  it('deleteSessions delegates non-empty arrays', async () => {
    const inner = makeInner();
    const storage = new EncryptedSessionStorage(inner, makeCipher());
    await storage.storeSession(
      makeOfflineSession('offline_foo', 'foo.myshopify.com', 'token-a'),
    );
    await storage.storeSession(
      makeOfflineSession('offline_bar', 'bar.myshopify.com', 'token-b'),
    );

    await storage.deleteSessions(['offline_foo', 'offline_bar']);
    expect(inner.rows.size).toBe(0);
  });
});
