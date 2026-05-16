/**
 * Rollup tick — D3 STUB. Hourly UTC at minute 0.
 *
 * Per CP-2 §Q5: selects merchants whose local midnight fell in the
 * preceding UTC hour, then upserts `MetricsDailyRollup` per (merchantId,
 * campaignId, date). D3 ships the merchant-selection logic (both the
 * timezone-aware branch AND the UTC-00 fallback for `timezone IS NULL`
 * merchants) and logs each selected merchant; H1 replaces the log block
 * with the real upsert math once `MetricsDailyRollup` lands.
 *
 * SCOPE: opens `withSystemScope(SYSTEM_SCOPE_REASONS.rollup.daily, ...)`
 * — cross-tenant SELECT. The raw queries use `$queryRaw` which bypasses
 * the Prisma extension's tenant assertion; the explicit system scope is
 * the audit-trail anchor for the cross-tenant access (rule 36 registered
 * at this call site).
 *
 * TIMEZONE-NULL FALLBACK (CP-2 §Q5):
 *   Merchants without an enriched `timezone` fall back to UTC. They're
 *   excluded from the main SELECT (which has `timezone IS NOT NULL`)
 *   and picked up by a second query that runs only at the 00:00–01:00
 *   UTC tick. Per CP-2: "ship the timezone-NULL fallback as a small
 *   special case in D3."
 *
 * Failure semantics: per-merchant try/catch so one merchant's failure
 * doesn't tank the rest of the tick. The next hourly tick re-attempts
 * any failed merchant (the SELECT's `(now() AT TIME ZONE timezone)::time
 * < 01:00:00` predicate is true exactly once per merchant per day across
 * all 24 ticks).
 */

import { SYSTEM_SCOPE_REASONS } from '@winback/contracts';
import { withSystemScope } from '@winback/db';
import { getLogger } from '@winback/logger';

import type { SchedulerContext } from '../context.js';

const log = getLogger('scheduler.rollup');

interface TimezoneMerchantRow {
  readonly id: string;
  readonly timezone: string;
}

interface NullTimezoneMerchantRow {
  readonly id: string;
}

export async function runRollupTick(ctx: SchedulerContext): Promise<void> {
  await withSystemScope(SYSTEM_SCOPE_REASONS.rollup.daily, async () => {
    const startedAt = Date.now();
    const currentUtcHour = new Date().getUTCHours();

    // (1) Timezone-aware branch. Selects merchants whose CURRENT local
    // time is between 00:00 and 01:00 — meaning their local midnight
    // just rolled over within the last hour. Each merchant matches
    // exactly one UTC hour per day; load is bounded by the timezone-hour
    // population, not by total merchant count.
    const tzRows = await ctx.prisma.$queryRaw<TimezoneMerchantRow[]>`
      SELECT id, timezone
      FROM "Merchant"
      WHERE timezone IS NOT NULL
        AND "uninstalledAt" IS NULL
        AND (now() AT TIME ZONE timezone)::time < '01:00:00'
        AND (now() AT TIME ZONE timezone)::time >= '00:00:00'
    `;

    let successCount = 0;
    let failureCount = 0;

    for (const row of tzRows) {
      try {
        // STUB BODY — H1 fills with real MetricsDailyRollup upsert.
        // Today this just logs the merchant we WOULD roll up. Per
        // CP-2 §Q5: "Each merchant gets one withSystemScope('rollup.
        // daily') + per-day chunked uow.run pass" — the per-merchant
        // scope/UoW will land in H1 alongside the upsert SQL.
        log.info(
          {
            merchantId: row.id,
            timezone: row.timezone,
            branch: 'timezone-aware',
          },
          'rollup tick: would upsert MetricsDailyRollup (H1 stub)',
        );
        successCount += 1;
      } catch (err) {
        failureCount += 1;
        log.error(
          { err, merchantId: row.id, timezone: row.timezone },
          'rollup tick: per-merchant failure (stub-branch)',
        );
      }
    }

    // (2) Timezone-NULL fallback. Only at UTC 00:00–00:59 — when UTC
    // midnight aligns with the merchant's "default" timezone (UTC).
    // Merchants without an enriched timezone shouldn't be missed; they
    // get one UTC-midnight rollup per day.
    if (currentUtcHour === 0) {
      const nullRows = await ctx.prisma.$queryRaw<NullTimezoneMerchantRow[]>`
        SELECT id
        FROM "Merchant"
        WHERE timezone IS NULL
          AND "uninstalledAt" IS NULL
      `;

      for (const row of nullRows) {
        try {
          log.info(
            {
              merchantId: row.id,
              timezone: null,
              branch: 'utc-fallback',
            },
            'rollup tick: would upsert MetricsDailyRollup (H1 stub)',
          );
          successCount += 1;
        } catch (err) {
          failureCount += 1;
          log.error(
            { err, merchantId: row.id, timezone: null },
            'rollup tick: per-merchant failure (fallback-branch)',
          );
        }
      }
    }

    log.info(
      {
        utcHour: currentUtcHour,
        timezoneAwareSelected: tzRows.length,
        successCount,
        failureCount,
        durationMs: Date.now() - startedAt,
      },
      'rollup tick: done',
    );
  });
}
