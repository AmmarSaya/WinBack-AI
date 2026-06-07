import type { PrismaClient } from '@prisma/client';
import { PrismaSessionStorage } from '@shopify/shopify-app-session-storage-prisma';
import { Cipher, decodeKey } from '@winback/crypto';
import { EncryptedSessionStorage, getShopifyConfig } from '@winback/shopify';

import { getPrisma } from './db.server.js';

/**
 * Process-singleton session storage, HMR-safe via globalThis.
 *
 * Composition (step 6 — Path A):
 *   PrismaSessionStorage (official `@shopify/shopify-app-session-storage-
 *   prisma` adapter, persistence) ← wrapped by ← EncryptedSessionStorage
 *   (AES-256-GCM around access tokens). The SDK sees an instance that
 *   satisfies `SessionStorage`; the DB sees ciphertext in the
 *   `Session.accessToken` column.
 *
 * The `PrismaSessionStorage` constructor expects a `PrismaClient` (the
 * raw shape, not our extended `WinbackPrisma`). At runtime our extended
 * client is structurally a PrismaClient — the cast is a typing-only
 * adaptation. The Session model is in `UNSCOPED_MODELS` so the extension
 * passes adapter queries through untouched.
 */
declare global {
   
  var __winbackSessionStorage: EncryptedSessionStorage | undefined;
}

export function getSessionStorage(): EncryptedSessionStorage {
  if (globalThis.__winbackSessionStorage === undefined) {
    const config = getShopifyConfig();
    const cipher = new Cipher(decodeKey(config.ENCRYPTION_KEY));
    const inner = new PrismaSessionStorage(getPrisma() as unknown as PrismaClient);
    globalThis.__winbackSessionStorage = new EncryptedSessionStorage(inner, cipher);
  }
  return globalThis.__winbackSessionStorage;
}
