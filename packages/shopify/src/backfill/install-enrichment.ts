import { OUTBOX_EVENTS } from '@winback/contracts';
import { UnitOfWork, type WinbackPrisma, withTenantScope } from '@winback/db';
import { getLogger } from '@winback/logger';

import type { AdminClient } from '../admin/client.js';
import { fetchShopDetails } from '../admin/shop-details.js';

const log = getLogger('shopify.install.enrichment');

export interface EnrichInstallResult {
  readonly merchantId: string;
  readonly success: boolean;
  readonly reason?: string;
}

/**
 * Backfills `Merchant.email/name/country/currency/timezone/shopifyPlan`
 * from Shopify's Shop query after install.
 *
 * GUARDRAIL #3 (C5): the field updates AND `shopDetailsFetchedAt` AND the
 * outbox event happen in a SINGLE transaction. If the Merchant update
 * fails for any reason, `shopDetailsFetchedAt` stays null and the health
 * check still flags this merchant as un-enriched — never the
 * "data-there-but-timestamp-null" state.
 *
 * The `fetchShopDetails` call runs BEFORE the tx opens. A fetch failure
 * doesn't open a tx at all — caller decides retry policy.
 *
 * Failures are returned as `{success: false, reason}` rather than thrown.
 * Enrichment is best-effort; the install itself already succeeded.
 *
 * CURRENT GAP — NO AUTOMATED RETRY YET:
 *   A failed enrichment is logged but not re-attempted. `Merchant.
 *   shopDetailsFetchedAt` stays null and the health check correctly
 *   reports the merchant as un-enriched, but nothing currently picks
 *   that up.
 *
 *   OWNING TASK (D3 — scheduler / cron, not yet built):
 *     "Sweep merchants where shopDetailsFetchedAt IS NULL AND
 *      installedAt < NOW() - INTERVAL '10 minutes' AND
 *      tokenRevokedAt IS NULL — re-invoke enrichInstall for each."
 *
 *   Until D3 lands, operators can surface stale un-enriched merchants
 *   via the same health-check query and trigger enrichment manually.
 */
export async function enrichInstall(
  prisma: WinbackPrisma,
  client: AdminClient,
  merchantId: string,
): Promise<EnrichInstallResult> {
  let details;
  try {
    details = await fetchShopDetails(client, merchantId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn({ merchantId, reason }, 'enrichInstall: fetchShopDetails failed');
    return { merchantId, success: false, reason };
  }

  try {
    const uow = new UnitOfWork(prisma);
    await withTenantScope(merchantId, async () => {
      await uow.run(async (ctx) => {
        // Field updates + timestamp — atomic. Single SQL UPDATE.
        await ctx.db.merchant.update({
          where: { id: merchantId },
          data: {
            email: details.email,
            name: details.name,
            country: details.country,
            currency: details.currency,
            timezone: details.timezone,
            shopifyPlan: details.plan,
            shopDetailsFetchedAt: new Date(),
          },
        });
        // Outbox event in the same tx — downstream workers (E intelligence,
        // operator dashboards) react to merchant enrichment becoming
        // available.
        await ctx.publish(OUTBOX_EVENTS.merchant.shop_details_fetched, {
          country: details.country,
          currency: details.currency,
          plan: details.plan,
        });
      });
    });
    log.info({ merchantId }, 'enrichInstall: merchant details persisted');
    return { merchantId, success: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error({ err, merchantId }, 'enrichInstall: tx failed');
    return { merchantId, success: false, reason };
  }
}
