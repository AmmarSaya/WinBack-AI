import { Cipher, decodeKey } from '@winback/crypto';
import { EncryptedSessionStorage, getShopifyConfig } from '@winback/shopify';

import { getPrisma } from './db.server.js';

/**
 * Process-singleton EncryptedSessionStorage. HMR-safe via globalThis (same
 * pattern as getPrisma).
 *
 * The constructor takes `WinbackPrisma` specifically — see
 * EncryptedSessionStorage's signature. Passing a raw PrismaClient is a TS
 * compile error.
 */
declare global {
  // eslint-disable-next-line no-var
  var __winbackSessionStorage: EncryptedSessionStorage | undefined;
}

export function getSessionStorage(): EncryptedSessionStorage {
  if (globalThis.__winbackSessionStorage === undefined) {
    const config = getShopifyConfig();
    const cipher = new Cipher(decodeKey(config.ENCRYPTION_KEY));
    globalThis.__winbackSessionStorage = new EncryptedSessionStorage(getPrisma(), cipher);
  }
  return globalThis.__winbackSessionStorage;
}
