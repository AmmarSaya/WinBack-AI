/**
 * Campaign dispatch sweep — 15-min tick on `cron.sweep` (Epic G batch 8.2).
 *
 * The PRODUCER half of the dispatch skeleton. Mirrors `runDecaySweep`'s shape:
 * a cross-tenant SELECT under system scope, then a per-merchant
 * `withTenantScope` pass. Here the per-merchant work is the dispatch PICKUP
 * (`CampaignRepository.findDispatchableDrafts`) followed by enqueueing one
 * `campaign.dispatch` job per eligible draft. The dispatch Worker
 * (`apps/drainer`) consumes those jobs and CLAIMS each draft.
 *
 * G-Q5: this tick is the re-evaluation point. A draft not claimed this tick
 * (transient failure, or it became eligible just after) is re-picked next
 * tick — the pickup's `NOT EXISTS CampaignTarget` filter makes that idempotent.
 *
 * SCOPE: `withSystemScope` wraps ONLY the cross-tenant merchant SELECT (raw
 * `$queryRaw` bypasses the tenant assertion; the system scope is the
 * audit-trail anchor, rule 36 registered at this call site). The per-merchant
 * pickup runs under `withTenantScope` so `queryRawScoped` passes its scope
 * assertion.
 *
 * SKELETON BOUNDARY: this batch enqueues + (in the worker) claims. NO gate
 * chain (8.3), NO send (8.4). The merchant SELECT excludes uninstalled /
 * token-revoked merchants (parity with the decay sweep) so dead merchants
 * never accrue pending targets.
 */

import {
  CAMPAIGN_DISPATCH_JOB_NAME,
  type CampaignDispatchJobPayload,
  SYSTEM_SCOPE_REASONS,
} from '@winback/contracts';
import {
  CampaignRepository,
  DEFAULT_DISPATCH_TAKE,
  withSystemScope,
  withTenantScope,
} from '@winback/db';
import { getLogger } from '@winback/logger';

import type { SchedulerContext } from '../context.js';

const log = getLogger('scheduler.dispatch-sweep');

/** BullMQ retry posture per dispatch job — recovers transient claim failures faster than the 15-min tick. */
const DISPATCH_JOB_ATTEMPTS = 3;
const DISPATCH_JOB_BACKOFF_MS = 5000;

interface DispatchMerchantRow {
  readonly id: string;
}

export async function runDispatchSweep(ctx: SchedulerContext): Promise<void> {
  await withSystemScope(SYSTEM_SCOPE_REASONS.campaign.dispatch_sweep, async () => {
    const startedAt = Date.now();

    // (1) Cross-tenant SELECT of LIVE merchants with >=1 active email
    // Campaign. The liveness filter (uninstalled / token-revoked excluded)
    // matches the decay sweep — no point dispatching for a dead merchant.
    const rows = await ctx.prisma.$queryRaw<DispatchMerchantRow[]>`
      SELECT DISTINCT m."id" AS id
      FROM "Merchant" m
      JOIN "Campaign" c ON c."merchantId" = m."id"
      WHERE c."status"::text = 'active'
        AND c."channel"::text = 'email'
        AND m."uninstalledAt" IS NULL
        AND m."tokenRevokedAt" IS NULL
    `;

    if (rows.length === 0) {
      log.debug(
        { durationMs: Date.now() - startedAt },
        'dispatch sweep: no live merchants with active email campaigns',
      );
      return;
    }

    const repo = new CampaignRepository(ctx.prisma);

    let merchantsSwept = 0;
    let merchantsFailed = 0;
    let totalEnqueued = 0;

    for (const row of rows) {
      try {
        const drafts = await withTenantScope(row.id, async () =>
          repo.findDispatchableDrafts({ merchantId: row.id }),
        );

        if (drafts.length > 0) {
          // One `campaign.dispatch` job per eligible draft (per-draft jobs —
          // per-message idempotency + retry/concurrency in later batches).
          // addBulk = one Redis round-trip for the whole merchant batch.
          await ctx.queues.campaignDispatch.addBulk(
            drafts.map((draft) => ({
              name: CAMPAIGN_DISPATCH_JOB_NAME,
              data: {
                merchantId: row.id,
                messageId: draft.messageId,
                campaignId: draft.campaignId,
                customerId: draft.customerId,
              } satisfies CampaignDispatchJobPayload,
              opts: {
                attempts: DISPATCH_JOB_ATTEMPTS,
                backoff: { type: 'exponential', delay: DISPATCH_JOB_BACKOFF_MS },
              },
            })),
          );
        }

        totalEnqueued += drafts.length;
        merchantsSwept += 1;

        // No silent caps: surface when a merchant saturated the per-tick take
        // so a backlog is visible (the remainder rides the next 15-min tick).
        if (drafts.length >= DEFAULT_DISPATCH_TAKE) {
          log.warn(
            { merchantId: row.id, enqueued: drafts.length, cap: DEFAULT_DISPATCH_TAKE },
            'dispatch sweep: per-merchant take cap hit — more drafts may remain; next 15-min tick picks them up (idempotent)',
          );
        } else {
          log.info(
            { merchantId: row.id, enqueued: drafts.length },
            'dispatch sweep: merchant pass complete',
          );
        }
      } catch (err) {
        merchantsFailed += 1;
        log.error(
          { err, merchantId: row.id },
          'dispatch sweep: per-merchant failure (will retry next 15-min tick)',
        );
      }
    }

    log.info(
      {
        candidates: rows.length,
        merchantsSwept,
        merchantsFailed,
        totalEnqueued,
        durationMs: Date.now() - startedAt,
      },
      'dispatch sweep: done',
    );
  });
}
