import type { Prisma } from '@prisma/client';
import { OUTBOX_EVENTS, SYSTEM_SCOPE_REASONS } from '@winback/contracts';
import { MerchantRepository, type WinbackPrisma, withSystemScope } from '@winback/db';
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
  // Merchant upsert routes through MerchantRepository.upsertInstall, which
  // does the findUnique+upsert atomically and returns `{id, isNewInstall}`.
  // No external read → no race.
  const merchantRepo = new MerchantRepository(prisma);

  return withSystemScope(SYSTEM_SCOPE_REASONS.shopify.install, async () => {
    return prisma.$transaction(async (extendedTx) => {
      // Prisma 5 typing gap. Calling `$transaction` on the extended client
      // returns the extended client type for the callback parameter, not
      // `Prisma.TransactionClient`. The two are not bidirectionally
      // assignable. Runtime extension hooks still fire on `extendedTx`;
      // only TS typing differs. Cast at this boundary so the repository's
      // `Prisma.TransactionClient` parameter accepts it. Pattern matches
      // UoW.run, which performs the same cast internally — see
      // `packages/db/src/unit-of-work.ts` lines 42-55 and 132-138 for the
      // mechanism and rationale. No public Prisma issue tracks this
      // specifically; revisit when Prisma improves callback typing in a
      // future major (Prisma 6+ does not fix this).
      const tx = extendedTx as unknown as Prisma.TransactionClient;

      const { id: merchantId, isNewInstall } = await merchantRepo.upsertInstall(
        { shop: args.shop },
        tx,
      );

      // Heal MerchantSettings — defensive create-if-missing on every install.
      await tx.merchantSettings.upsert({
        where: { merchantId },
        create: { merchantId },
        update: {},
      });

      // Heal BillingSubscription.
      await tx.billingSubscription.upsert({
        where: { merchantId },
        create: { merchantId, status: 'trialing' },
        update: {},
      });

      await tx.outboxEvent.create({
        data: {
          merchantId,
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
          merchantId,
          shop: args.shop,
          reinstall: !isNewInstall,
        },
        isNewInstall ? 'Merchant install completed' : 'Merchant reinstall completed',
      );

      return { merchantId, isNewInstall };
    });
  });
}
