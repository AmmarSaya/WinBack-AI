/**
 * Campaign dispatch sweep — 15-min tick on `cron.sweep` (Epic G batch 8.2 +
 * 8.3 arm 2).
 *
 * The PRODUCER half. Mirrors `runDecaySweep`'s shape: a cross-tenant SELECT
 * under system scope, then a per-merchant `withTenantScope` pass with TWO
 * disjoint arms:
 *
 *   ARM 1 (8.2) — fresh drafts: `findDispatchableDrafts` (status=draft, NO
 *     `CampaignTarget` yet) → one `campaign.dispatch` job per draft → the
 *     worker CLAIMS + GATES each.
 *   ARM 2 (8.3) — deferred re-entry: `findDeferredTargets` (status=deferred).
 *     A target whose `createdAt` is past `MAX_DISPATCH_AGE` is EXPIRED
 *     (`deferred_stale`); one whose campaign is no longer active is RESOLVED
 *     (`campaign_paused`); the rest re-enqueue for re-gating. This is how a
 *     transient gate (quiet-hours/quota) gets re-evaluated — the arm-1
 *     `NOT EXISTS` pickup can NEVER re-select a claimed target, so re-entry
 *     rides this distinct status=deferred query (G-Q5 = the tick is the
 *     re-evaluation point).
 *
 * SCOPE: `withSystemScope` wraps ONLY the cross-tenant merchant SELECT (raw
 * `$queryRaw` bypasses the tenant assertion; the system scope is the
 * audit-trail anchor, rule 36 registered at this call site). Both arms +
 * arm-2's terminal resolutions run under the per-merchant `withTenantScope`.
 *
 * The merchant SELECT excludes uninstalled / token-revoked merchants (parity
 * with the decay sweep) so dead merchants never accrue or churn targets.
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

/**
 * Max time a target may sit `deferred` before arm 2 EXPIRES it (8.3, ruling 3).
 * Anchored on the immutable `CampaignTarget.createdAt` (NOT `updatedAt`, which
 * resets every 15-min re-entry). 3 days: long enough to clear any legitimate
 * transient deferral (quiet-hours/quota), short enough that an older "we miss
 * you" is no longer truthful. Tunable here, no migration.
 */
const MAX_DISPATCH_AGE_MS = 3 * 24 * 60 * 60 * 1000;

interface DispatchMerchantRow {
  readonly id: string;
}

/** A job to (re-)enqueue — the shared shape of an arm-1 draft and an arm-2 re-entry. */
interface DispatchJobItem {
  readonly messageId: string;
  readonly campaignId: string;
  readonly customerId: string;
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
    let totalStaleExpired = 0;
    let totalPausedResolved = 0;

    for (const row of rows) {
      try {
        // ONE tenant scope per merchant covering both arms. ARM 1 = fresh
        // drafts (no target yet). ARM 2 = `deferred` targets re-entering: a
        // STALE one (createdAt past MAX_DISPATCH_AGE) is expired; a PAUSED-campaign
        // one is resolved; the rest re-enqueue for re-gating. Arms 1 + 2 are
        // disjoint by construction (no-target vs status=deferred).
        const merchant = await withTenantScope(row.id, async () => {
          const drafts = await repo.findDispatchableDrafts({ merchantId: row.id });
          const deferred = await repo.findDeferredTargets({ merchantId: row.id });

          const toEnqueue: DispatchJobItem[] = drafts.map((d) => ({
            messageId: d.messageId,
            campaignId: d.campaignId,
            customerId: d.customerId,
          }));

          let staleExpired = 0;
          let pausedResolved = 0;
          for (const d of deferred) {
            if (startedAt - d.createdAt.getTime() > MAX_DISPATCH_AGE_MS) {
              // Anti-leak: a perpetually-deferred target would re-enter every
              // tick forever AND go stale. Expire it (terminal), don't re-enqueue.
              await repo.resolveTerminal({ messageId: d.messageId, reason: 'deferred_stale' });
              staleExpired += 1;
            } else if (!d.campaignActive) {
              // The owning campaign was paused/archived while deferred — resolve,
              // never re-enqueue a target whose campaign no longer dispatches.
              await repo.resolveTerminal({ messageId: d.messageId, reason: 'campaign_paused' });
              pausedResolved += 1;
            } else {
              toEnqueue.push({
                messageId: d.messageId,
                campaignId: d.campaignId,
                customerId: d.customerId,
              });
            }
          }

          return { toEnqueue, draftCount: drafts.length, staleExpired, pausedResolved };
        });

        if (merchant.toEnqueue.length > 0) {
          // addBulk = one Redis round-trip for the merchant's arm-1 + arm-2 jobs.
          await ctx.queues.campaignDispatch.addBulk(
            merchant.toEnqueue.map((item) => ({
              name: CAMPAIGN_DISPATCH_JOB_NAME,
              data: {
                merchantId: row.id,
                messageId: item.messageId,
                campaignId: item.campaignId,
                customerId: item.customerId,
              } satisfies CampaignDispatchJobPayload,
              opts: {
                attempts: DISPATCH_JOB_ATTEMPTS,
                backoff: { type: 'exponential', delay: DISPATCH_JOB_BACKOFF_MS },
              },
            })),
          );
        }

        totalEnqueued += merchant.toEnqueue.length;
        totalStaleExpired += merchant.staleExpired;
        totalPausedResolved += merchant.pausedResolved;
        merchantsSwept += 1;

        // No silent caps: surface when a merchant saturated the per-tick draft
        // take so a backlog is visible (the remainder rides the next tick).
        if (merchant.draftCount >= DEFAULT_DISPATCH_TAKE) {
          log.warn(
            { merchantId: row.id, drafts: merchant.draftCount, cap: DEFAULT_DISPATCH_TAKE },
            'dispatch sweep: per-merchant draft take cap hit — more may remain; next 15-min tick picks them up (idempotent)',
          );
        }
        log.info(
          {
            merchantId: row.id,
            enqueued: merchant.toEnqueue.length,
            drafts: merchant.draftCount,
            staleExpired: merchant.staleExpired,
            pausedResolved: merchant.pausedResolved,
          },
          'dispatch sweep: merchant pass complete (arm 1 drafts + arm 2 deferred re-entry)',
        );
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
        totalStaleExpired,
        totalPausedResolved,
        durationMs: Date.now() - startedAt,
      },
      'dispatch sweep: done',
    );
  });
}
