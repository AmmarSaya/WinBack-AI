import type { Cipher } from '@winback/crypto';
import type { WinbackPrisma } from '@winback/db';
import { getLogger } from '@winback/logger';

import type { SessionStorage, ShopifySession } from './types.js';

const log = getLogger('shopify.session-storage');

/**
 * Implements the Shopify `SessionStorage` interface, persisting to the
 * Prisma `Session` table with `accessToken` ENCRYPTED at the storage
 * boundary.
 *
 * Constructor takes `WinbackPrisma` (NOT raw `PrismaClient`) by design —
 * the type rejection prevents future developers from accidentally passing
 * an unwrapped client. Session is `UNSCOPED_MODELS` in our extension so
 * the runtime behavior is the same either way, but the type-level
 * declaration encodes the intent.
 *
 * Session writes happen OUTSIDE any tenant scope — they precede the
 * Merchant row's existence during install, and they're keyed by `shop`
 * not by merchant id. This is the ONE legitimate place in the codebase
 * where unscoped database writes occur, and it works because Session is
 * the unscoped model.
 */
export class EncryptedSessionStorage implements SessionStorage {
  constructor(
    private readonly prisma: WinbackPrisma,
    private readonly cipher: Cipher,
  ) {}

  async storeSession(session: ShopifySession): Promise<boolean> {
    const encrypted = session.accessToken !== undefined
      ? this.cipher.encrypt(session.accessToken)
      : '';

    const data = {
      shop: session.shop,
      state: session.state,
      isOnline: session.isOnline,
      scope: session.scope ?? null,
      expires: session.expires ?? null,
      accessToken: encrypted,
      userId: toBigIntOrNull(session.userId),
      firstName: session.firstName ?? null,
      lastName: session.lastName ?? null,
      email: session.email ?? null,
      accountOwner: session.accountOwner ?? false,
      locale: session.locale ?? null,
      collaborator: session.collaborator ?? false,
      emailVerified: session.emailVerified ?? false,
    };

    await this.prisma.session.upsert({
      where: { id: session.id },
      create: { id: session.id, ...data },
      update: data,
    });
    return true;
  }

  async loadSession(id: string): Promise<ShopifySession | undefined> {
    const row = await this.prisma.session.findUnique({ where: { id } });
    if (row === null) return undefined;
    return this.rowToSession(row);
  }

  async deleteSession(id: string): Promise<boolean> {
    try {
      await this.prisma.session.delete({ where: { id } });
      return true;
    } catch (err) {
      // P2025: record not found — idempotent delete behavior.
      log.debug({ err, id }, 'Session delete: row not found (idempotent OK)');
      return true;
    }
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    if (ids.length === 0) return true;
    await this.prisma.session.deleteMany({ where: { id: { in: ids } } });
    return true;
  }

  async findSessionsByShop(shop: string): Promise<ShopifySession[]> {
    const rows = await this.prisma.session.findMany({ where: { shop } });
    return rows.map((row) => this.rowToSession(row));
  }

  private rowToSession(row: {
    id: string;
    shop: string;
    state: string;
    isOnline: boolean;
    scope: string | null;
    expires: Date | null;
    accessToken: string;
    userId: bigint | null;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    accountOwner: boolean;
    locale: string | null;
    collaborator: boolean | null;
    emailVerified: boolean | null;
  }): ShopifySession {
    const accessToken = row.accessToken.length > 0
      ? this.cipher.decrypt(row.accessToken)
      : undefined;
    return {
      id: row.id,
      shop: row.shop,
      state: row.state,
      isOnline: row.isOnline,
      scope: row.scope ?? undefined,
      expires: row.expires ?? undefined,
      accessToken,
      userId: row.userId ?? undefined,
      firstName: row.firstName ?? undefined,
      lastName: row.lastName ?? undefined,
      email: row.email ?? undefined,
      accountOwner: row.accountOwner,
      locale: row.locale ?? undefined,
      collaborator: row.collaborator ?? undefined,
      emailVerified: row.emailVerified ?? undefined,
    };
  }
}

function toBigIntOrNull(v: string | number | bigint | undefined): bigint | null {
  if (v === undefined) return null;
  if (typeof v === 'bigint') return v;
  try {
    return BigInt(v.toString());
  } catch {
    return null;
  }
}
