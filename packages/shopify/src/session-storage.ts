import { Session } from '@shopify/shopify-api';
import type { SessionStorage } from '@shopify/shopify-app-session-storage';
import type { Cipher } from '@winback/crypto';
import { getLogger } from '@winback/logger';

const log = getLogger('shopify.session-storage');

/**
 * AES-256-GCM-encrypting decorator over a `SessionStorage` from
 * `@shopify/shopify-app-session-storage`. The inner adapter does all
 * persistence (Prisma CRUD on the Session table); this class wraps each
 * call to encrypt the access token on the way down and decrypt it on the
 * way up. The DB column always contains ciphertext.
 *
 * Why a decorator and not direct CRUD: the Shopify SDK (specifically
 * `@shopify/shopify-app-session-storage-prisma`) owns the Session-to-row
 * mapping, including the round-trip through `Session.fromPropertyArray`
 * for `loadSession`. Re-implementing that mapping inside our class would
 * be duplication that drifts. Delegating to the adapter means the SDK is
 * the source of truth for the on-disk row shape; we add encryption.
 *
 * Contract with callers (and the SDK):
 *   - storeSession(session: Session) — encrypts `session.accessToken` on
 *     a clone before delegating. The caller's instance is NOT mutated.
 *   - loadSession(id) — delegates, then decrypts `accessToken` in place
 *     on the returned `Session` (the SDK field is public mutable).
 *     `Session` class methods (`isActive()`, `isExpired()`, etc.) are
 *     preserved because the instance came from the adapter.
 *   - findSessionsByShop(shop) — delegates + decrypts each in place.
 *   - deleteSession / deleteSessions — pass-through.
 *
 * What the cipher operates on:
 *   - Empty access token (Session.accessToken === undefined or '') —
 *     not encrypted. Empty stays empty. This matches the adapter's
 *     `sessionToRow` behavior of writing `accessToken: ''` when absent.
 *
 * Scope semantics: Session writes happen OUTSIDE any tenant scope —
 * Session is `UNSCOPED_MODELS` in our Prisma extension so the extension
 * passes the queries through. Callers do not need to wrap in
 * `withTenantScope` or `withSystemScope`.
 */
export class EncryptedSessionStorage implements SessionStorage {
  constructor(
    private readonly inner: SessionStorage,
    private readonly cipher: Cipher,
  ) {}

  async storeSession(session: Session): Promise<boolean> {
    const original = session.accessToken;
    if (original === undefined || original.length === 0) {
      // No token to encrypt — delegate as-is.
      return this.inner.storeSession(session);
    }
    // Clone via toObject() so onlineAccessInfo and any extension fields
    // round-trip cleanly through the Session constructor.
    const clone = new Session({
      ...session.toObject(),
      accessToken: this.cipher.encrypt(original),
    });
    return this.inner.storeSession(clone);
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const session = await this.inner.loadSession(id);
    if (session === undefined) return undefined;
    if (session.accessToken !== undefined && session.accessToken.length > 0) {
      try {
        session.accessToken = this.cipher.decrypt(session.accessToken);
      } catch (err) {
        // Corrupt ciphertext (wrong key, truncation, etc.). Treat as no
        // usable token so callers surface a re-auth flow rather than
        // ship plaintext-of-ciphertext as the access token. Use `delete`
        // (not `= undefined`) because `accessToken?: string` under
        // exactOptionalPropertyTypes: assigning `undefined` to an
        // optional property is rejected by TS — `delete` is the honest
        // way to express "this property is now absent."
        log.warn({ id, err }, 'EncryptedSessionStorage: decrypt failed; dropping accessToken');
        delete session.accessToken;
      }
    }
    return session;
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.inner.deleteSession(id);
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    if (ids.length === 0) return true;
    return this.inner.deleteSessions(ids);
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const sessions = await this.inner.findSessionsByShop(shop);
    for (const session of sessions) {
      if (session.accessToken !== undefined && session.accessToken.length > 0) {
        try {
          session.accessToken = this.cipher.decrypt(session.accessToken);
        } catch (err) {
          // See loadSession for the `delete` rationale (exactOptional-
          // PropertyTypes prohibits `= undefined` on `accessToken?: string`).
          log.warn(
            { id: session.id, err },
            'EncryptedSessionStorage: decrypt failed for findSessionsByShop row',
          );
          delete session.accessToken;
        }
      }
    }
    return sessions;
  }
}
