import { OUTBOX_EVENTS } from '@winback/contracts';
import type { Cipher } from '@winback/crypto';
import { type WinbackPrisma, withSystemScope } from '@winback/db';

export interface ResolvedToken {
  readonly shop: string;
  readonly accessToken: string;
}

/**
 * The token boundary. The AdminClient depends on this interface, NOT on
 * raw access-token strings. Callers of AdminClient pass `merchantId`; the
 * resolver looks up + decrypts internally.
 *
 * This is structural enforcement of the "callers never handle raw tokens"
 * rule: the AdminClient's public methods accept merchantId, and the only
 * way to wire it up is to pass an implementation of this interface at
 * construction. A future developer who tries to "just pass the token"
 * has nowhere in the API to put it.
 */
export interface ShopifyTokenResolver {
  /**
   * Returns `null` if no usable offline token exists (merchant not found,
   * token revoked, or session row missing). Callers should treat null as
   * "merchant needs re-auth."
   */
  getOfflineToken(merchantId: string): Promise<ResolvedToken | null>;

  /**
   * Marks the merchant's offline token as revoked and emits a
   * `merchant.needs_reauth` outbox event. Called by the AdminClient when
   * Shopify returns 401.
   */
  markTokenRevoked(merchantId: string): Promise<void>;
}

/**
 * Production implementation. Reads the merchant's offline session via
 * Prisma, decrypts the access token via the @winback/crypto Cipher.
 *
 * Constructor signature accepts `WinbackPrisma` specifically (not the raw
 * `PrismaClient`) per the standing rule — TS rejects an unwrapped client.
 */
export class PrismaShopifyTokenResolver implements ShopifyTokenResolver {
  constructor(
    private readonly prisma: WinbackPrisma,
    private readonly cipher: Cipher,
  ) {}

  async getOfflineToken(merchantId: string): Promise<ResolvedToken | null> {
    return withSystemScope('admin.token_resolve', async () => {
      const merchant = await this.prisma.merchant.findUnique({
        where: { id: merchantId },
        select: { shop: true, tokenRevokedAt: true },
      });
      if (merchant === null) return null;
      if (merchant.tokenRevokedAt !== null) return null;

      const session = await this.prisma.session.findUnique({
        where: { id: `offline_${merchant.shop}` },
        select: { accessToken: true },
      });
      if (session === null || session.accessToken.length === 0) return null;

      try {
        const plaintext = this.cipher.decrypt(session.accessToken);
        return { shop: merchant.shop, accessToken: plaintext };
      } catch {
        // Decryption failure (corrupt ciphertext, wrong key). Treat as
        // "no usable token" — caller will surface ShopifyTokenRevokedError.
        return null;
      }
    });
  }

  async markTokenRevoked(merchantId: string): Promise<void> {
    await withSystemScope('admin.token_revoke', async () => {
      await this.prisma.$transaction(async (tx) => {
        await tx.merchant.update({
          where: { id: merchantId },
          data: { tokenRevokedAt: new Date() },
        });
        await tx.outboxEvent.create({
          data: {
            merchantId,
            type: OUTBOX_EVENTS.merchant.needs_reauth,
            payload: { reason: 'token_revoked_401' },
          },
        });
      });
    });
  }
}
