/**
 * Enrichment retry sweep — D3 cron sweep. Every 15 minutes.
 *
 * Closes the gap that D2's `merchant.installed` handler explicitly
 * defers to D3 (see [install-enrichment.ts:43-46](packages/shopify/src/backfill/install-enrichment.ts:43)
 * and [merchant.ts:74-83](apps/drainer/src/handlers/merchant.ts:74)).
 *
 * Algorithm:
 *
 *   withSystemScope('enrichment.sweep', async () => {
 *     1. SELECT merchants where shopDetailsFetchedAt IS NULL AND
 *        installedAt < NOW() - INTERVAL '10 minutes' AND
 *        tokenRevokedAt IS NULL AND uninstalledAt IS NULL
 *        (supported by the Merchant_un_enriched_idx partial index)
 *     2. For each merchant:
 *        - Build AdminClient via buildAdminClient(prisma, config)
 *        - Call enrichInstall(prisma, adminClient, merchantId)
 *        - enrichInstall does not throw — inspect {success, reason}
 *        - Per-merchant try/catch contains unexpected throws so one
 *          merchant's failure doesn't tank the rest of the sweep
 *     3. Log success / failure / no-op counts
 *   });
 *
 * The next 15-min tick re-runs this — un-enriched merchants whose
 * `enrichInstall` failed get retried. The query naturally excludes
 * merchants enriched on the prior tick (`shopDetailsFetchedAt IS NULL`
 * → false after success).
 *
 * Idempotency: enrichInstall is an upsert (Merchant fields +
 * shopDetailsFetchedAt timestamp), so a re-invocation on an already-
 * enriched merchant would be safe even if the SELECT predicate were
 * missed. The predicate is just the efficiency gate.
 */

import { SYSTEM_SCOPE_REASONS } from '@winback/contracts';
import { withSystemScope } from '@winback/db';
import { getLogger } from '@winback/logger';
import { buildAdminClient, enrichInstall } from '@winback/shopify';

import type { SchedulerContext } from '../context.js';

const log = getLogger('scheduler.enrichment-sweep');

interface UnEnrichedMerchantRow {
  readonly id: string;
}

export async function runEnrichmentSweep(ctx: SchedulerContext): Promise<void> {
  await withSystemScope(SYSTEM_SCOPE_REASONS.enrichment.sweep, async () => {
    const startedAt = Date.now();

    // Cross-tenant SELECT. Supported by Merchant_un_enriched_idx (the
    // hand-authored partial index that ships with D3) — see migrations/
    // 20260516120000_merchant_un_enriched_idx/migration.sql.
    const rows = await ctx.prisma.$queryRaw<UnEnrichedMerchantRow[]>`
      SELECT id
      FROM "Merchant"
      WHERE "shopDetailsFetchedAt" IS NULL
        AND "installedAt" < NOW() - INTERVAL '10 minutes'
        AND "tokenRevokedAt" IS NULL
        AND "uninstalledAt" IS NULL
    `;

    if (rows.length === 0) {
      log.debug({ durationMs: Date.now() - startedAt }, 'enrichment sweep: no candidates');
      return;
    }

    let successCount = 0;
    let failureCount = 0;

    for (const row of rows) {
      try {
        const adminClient = buildAdminClient(ctx.prisma, ctx.shopifyConfig);
        const result = await enrichInstall(ctx.prisma, adminClient, row.id);

        if (result.success) {
          successCount += 1;
          log.info(
            { merchantId: row.id },
            'enrichment sweep: enrichInstall succeeded',
          );
        } else {
          failureCount += 1;
          log.warn(
            { merchantId: row.id, reason: result.reason },
            'enrichment sweep: enrichInstall returned non-success (will retry next tick)',
          );
        }
      } catch (err) {
        // enrichInstall is designed not to throw, but defense-in-depth
        // against future regressions: catch + count so one merchant's
        // unexpected throw doesn't terminate the sweep.
        failureCount += 1;
        log.error(
          { err, merchantId: row.id },
          'enrichment sweep: unexpected throw from enrichInstall (will retry next tick)',
        );
      }
    }

    log.info(
      {
        candidates: rows.length,
        successCount,
        failureCount,
        durationMs: Date.now() - startedAt,
      },
      'enrichment sweep: done',
    );
  });
}
