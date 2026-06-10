/**
 * Decay-rescore sweep — daily cron at 03:00 UTC (post-Epic-F).
 *
 * The steady-state companion to §1's install-day bulk-rescore. Scoring
 * is otherwise webhook-only (`recompute` fires from `orders/*` +
 * `customers/*` events). A customer who goes quiet AFTER install emits
 * zero webhooks, so their band never decays even as `rDays` climbs past
 * the active/warm/at_risk/dormant thresholds. This sweep re-evaluates
 * customers on the calendar so a purely time-driven lapse
 * (e.g. `active → dormant` with no new orders) is detected and fires a
 * winback.
 *
 * Algorithm (mirrors `runEnrichmentSweep`):
 *
 *   withSystemScope('scoring.decay_sweep', async () => {
 *     1. Cross-tenant SELECT of INITIALIZED, live merchants:
 *        scoringInitializedAt IS NOT NULL  (the §1 gate — a merchant
 *          mid-first-pass must not decay-emit)
 *        AND uninstalledAt IS NULL
 *        AND tokenRevokedAt IS NULL
 *     2. Per merchant: withTenantScope(merchantId) →
 *        CustomerScoreService.decayRescore(prisma, { merchantId, ... }).
 *        decayRescore reads the cohort ONCE, re-evaluates the working
 *        set (active/warm/at_risk/dormant — skips terminal `lost` +
 *        cohort-driven `insufficient_data`), and emits
 *        customer.state_changed for real band transitions (gated again
 *        on scoringInitializedAt, defensively).
 *     3. Per-merchant try/catch so one merchant's failure doesn't tank
 *        the rest of the sweep. The next daily tick re-attempts.
 *   });
 *
 * RATE-LIMITING. None here. Emitted events flow through the drainer to
 * `handleCustomerStateChanged`, where A2's per-merchant hourly cap
 * (STEP 4.5) bounds the downstream LLM burst — same gate a webhook
 * would hit. (This is why A2 was sequenced before the sweep.)
 *
 * SCOPE: `withSystemScope` wraps the cross-tenant SELECT (raw
 * `$queryRaw` bypasses the Prisma extension's tenant assertion; the
 * explicit system scope is the audit-trail anchor for the cross-tenant
 * access, rule 36 registered at this call site). Each per-merchant
 * `decayRescore` is wrapped in its own `withTenantScope` because
 * `UnitOfWork.run` (inside `decayRescore`) requires the active scope to
 * match the merchant.
 *
 * LAUNCH PREREQUISITE: see `decayRescore`'s docstring + POST-EPIC-F
 * "Decay-rescore sweep". The sweep MUST NOT be enabled for a real
 * merchant with significant pre-install order history until an
 * order-backfill exists, or it will false-lapse actively-buying
 * customers whose orders we never captured.
 */

import { SYSTEM_SCOPE_REASONS } from '@winback/contracts';
import {
  AuditLogRepository,
  CustomerScoreRepository,
  CustomerScoreService,
  withSystemScope,
  withTenantScope,
} from '@winback/db';
import { getLogger } from '@winback/logger';

import type { SchedulerContext } from '../context.js';

const log = getLogger('scheduler.decay-sweep');

interface InitializedMerchantRow {
  readonly id: string;
}

/** Actor recorded on every decay-driven customer.state_changed audit. */
const DECAY_SWEEP_ACTOR_ID = 'scheduler';

export async function runDecaySweep(ctx: SchedulerContext): Promise<void> {
  await withSystemScope(SYSTEM_SCOPE_REASONS.scoring.decay_sweep, async () => {
    const startedAt = Date.now();

    // (1) Cross-tenant SELECT of initialized, live merchants. The
    // scoringInitializedAt filter is the §1 gate at the SELECT layer —
    // a merchant mid-first-pass is excluded entirely (decayRescore also
    // gates emission defensively, so this is belt-and-suspenders).
    const rows = await ctx.prisma.$queryRaw<InitializedMerchantRow[]>`
      SELECT id
      FROM "Merchant"
      WHERE "scoringInitializedAt" IS NOT NULL
        AND "uninstalledAt" IS NULL
        AND "tokenRevokedAt" IS NULL
    `;

    if (rows.length === 0) {
      log.debug({ durationMs: Date.now() - startedAt }, 'decay sweep: no initialized merchants');
      return;
    }

    const scoringService = new CustomerScoreService(
      new CustomerScoreRepository(ctx.prisma),
      new AuditLogRepository(ctx.prisma),
    );

    let merchantsSwept = 0;
    let merchantsFailed = 0;
    let totalTransitions = 0;
    let totalEmitted = 0;

    for (const row of rows) {
      try {
        const result = await withTenantScope(row.id, async () =>
          scoringService.decayRescore(ctx.prisma, {
            merchantId: row.id,
            actorId: DECAY_SWEEP_ACTOR_ID,
          }),
        );
        merchantsSwept += 1;
        totalTransitions += result.transitions;
        totalEmitted += result.emitted;
        log.info(
          {
            merchantId: row.id,
            customersEvaluated: result.customersEvaluated,
            transitions: result.transitions,
            emitted: result.emitted,
            cohortSize: result.cohortSize,
            durationMs: result.durationMs,
          },
          'decay sweep: merchant pass complete',
        );
      } catch (err) {
        merchantsFailed += 1;
        log.error(
          { err, merchantId: row.id },
          'decay sweep: per-merchant failure (will retry next daily tick)',
        );
      }
    }

    log.info(
      {
        candidates: rows.length,
        merchantsSwept,
        merchantsFailed,
        totalTransitions,
        totalEmitted,
        durationMs: Date.now() - startedAt,
      },
      'decay sweep: done',
    );
  });
}
