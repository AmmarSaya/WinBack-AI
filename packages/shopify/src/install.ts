import { OUTBOX_EVENTS } from '@winback/contracts';
import { type WinbackPrisma, withSystemScope } from '@winback/db';
import { getLogger } from '@winback/logger';

import { ShopifyInvalidShopError } from './errors.js';
import { isValidShopDomain } from './shop-domain.js';

const log = getLogger('shopify.install');

export interface CompleteInstallArgs {
  readonly shop: string;
  readonly accessToken: string;
  readonly scope: string;
}

export interface CompleteInstallResult {
  readonly merchantId: string;
  readonly isNewInstall: boolean;
}

/**
 * Finalizes a Shopify install once OAuth + token exchange have succeeded.
 *
 *   - Atomic creation of: Merchant + MerchantSettings + BillingSubscription
 *     + initial OutboxEvent (`merchant.installed@v1`).
 *   - Re-install case: clears `tokenRevokedAt` + `uninstalledAt`, emits
 *     `merchant.installed@v1` with `reinstall: true`.
 *
 * The session row (which holds the encrypted `accessToken`) is written by
 * the caller AFTER this function returns, via `EncryptedSessionStorage`.
 * It's intentionally separate because session writes are unscoped and
 * idempotent — if they fail, the next OAuth attempt re-triggers them.
 *
 * SCOPE: this is the ONE place in the codebase that opens
 * `withSystemScope('shopify.install')` for a merchant-creating write.
 * Inside, we use `prisma.$transaction` directly (NOT UnitOfWork.run)
 * because UnitOfWork requires a tenant scope, and at this moment the
 * tenant doesn't exist yet.
 */
export async function completeInstall(
  prisma: WinbackPrisma,
  args: CompleteInstallArgs,
): Promise<CompleteInstallResult> {
  if (!isValidShopDomain(args.shop)) {
    throw new ShopifyInvalidShopError(args.shop);
  }

  // Single atomic tx that UPSERTS every row this install requires. The
  // four upserts heal partial-failure state from any prior install
  // attempt — if a previous attempt committed a Merchant row but the
  // MerchantSettings or BillingSubscription rows are missing (data
  // migration mishap, hand-edit, race during a crash), the next install
  // restores invariants instead of getting stuck.
  //
  // `findUnique` inside the tx determines new-vs-reinstall atomically
  // with the subsequent writes. No external read → no race.
  return withSystemScope('shopify.install', async () => {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.merchant.findUnique({
        where: { shop: args.shop },
        select: { id: true },
      });
      const isNewInstall = existing === null;

      const merchant = await tx.merchant.upsert({
        where: { shop: args.shop },
        create: { shop: args.shop, installedAt: new Date() },
        update: { tokenRevokedAt: null, uninstalledAt: null },
        select: { id: true },
      });

      // Heal MerchantSettings — defensive create-if-missing on every install.
      await tx.merchantSettings.upsert({
        where: { merchantId: merchant.id },
        create: { merchantId: merchant.id },
        update: {},
      });

      // Heal BillingSubscription.
      await tx.billingSubscription.upsert({
        where: { merchantId: merchant.id },
        create: { merchantId: merchant.id, status: 'trialing' },
        update: {},
      });

      await tx.outboxEvent.create({
        data: {
          merchantId: merchant.id,
          type: OUTBOX_EVENTS.merchant.installed,
          payload: {
            shop: args.shop,
            scope: args.scope,
            reinstall: !isNewInstall,
          },
        },
      });

      log.info(
        {
          merchantId: merchant.id,
          shop: args.shop,
          reinstall: !isNewInstall,
        },
        isNewInstall ? 'Merchant install completed' : 'Merchant reinstall completed',
      );

      return { merchantId: merchant.id, isNewInstall };
    });
  });
}
