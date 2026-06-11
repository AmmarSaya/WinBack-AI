/**
 * Dispatch Worker — BullMQ consumer for the `campaign.dispatch` queue
 * (Epic G batch 8.2 — the dispatch skeleton's CONSUMER half).
 *
 * Runs as a THIRD BullMQ Worker INSIDE `apps/drainer` (alongside the outbox
 * drain Worker and the AI Worker, each a separate Worker instance with its own
 * ioredis connection). The producer is the scheduler's 15-min `dispatch-sweep`
 * tick, which enqueues one job per dispatch-eligible draft.
 *
 * WHAT IT DOES (skeleton): CLAIMS the draft by creating its `CampaignTarget`
 * (status=pending) — `CampaignRepository.claimTarget`. That's it.
 *
 * WHAT IT DOES NOT DO (later batches): NO gate chain (suppression / consent /
 * freshness / frequency / quiet-hours / quota — 8.3). NO ESP send, NO
 * `MessageEvent`, NO quota increment, NO `Message.status` change (8.4). The
 * claimed `CampaignTarget(pending)` waits for those batches.
 *
 * IDEMPOTENCY: the claim is idempotent on `CampaignTarget.messageId @unique` —
 * a duplicate job or a tick/worker race resolves to `already_claimed` (a no-op,
 * not an error). This is the backstop behind the producer's `NOT EXISTS
 * CampaignTarget` pickup filter. No BullMQ jobId dedup is used (it would risk a
 * failed-job-wedge under `removeOnComplete`); the unique constraint is the
 * guarantee, the pickup filter is the optimisation.
 *
 * RETRY: jobs carry `attempts: 3` + exponential backoff (set by the producer).
 * A transient claim failure (e.g. a brief DB blip) retries within seconds; an
 * exhausted job lands in BullMQ's failed set and is naturally re-picked by the
 * next 15-min tick (the draft is still unclaimed → the pickup re-enqueues it).
 */

import {
  type CampaignDispatchJobPayload,
  QUEUE_NAMES,
} from '@winback/contracts';
import { CampaignRepository, withTenantScope } from '@winback/db';
import { getLogger } from '@winback/logger';
import { createRedisClient } from '@winback/queue';
import { Worker, type Job } from 'bullmq';

import type { DrainerContext } from '../context.js';

const log = getLogger('drainer.worker.dispatch');

/**
 * Concurrency = 1 (matches the sibling workers). The claim is a cheap,
 * idempotent single write with NO external rate limit (unlike the AI Worker's
 * Shopify calls), so it drains a tick's batch quickly even at 1. Per-merchant
 * send-rate concurrency tuning is an 8.4 (send) concern, not a skeleton one.
 */
const WORKER_CONCURRENCY = 1;

/** 1 min — the claim is a single fast write; generous headroom against a slow DB. */
const WORKER_LOCK_DURATION_MS = 60 * 1000;

/**
 * Single-job processor. Exported separately from the factory so unit tests
 * drive the flow with a synthetic Job without standing up a real BullMQ Worker
 * (which needs Redis).
 */
export async function processCampaignDispatchJob(
  ctx: DrainerContext,
  job: Job<CampaignDispatchJobPayload>,
): Promise<void> {
  const payload = job.data;

  await withTenantScope(payload.merchantId, async () => {
    // The claim. `claimTarget` creates the pending CampaignTarget under the
    // active tenant scope (the extension asserts merchantId). A P2002 on the
    // messageId @unique returns 'already_claimed' — never throws — so a
    // duplicate job / tick-worker race is a clean no-op.
    const repo = new CampaignRepository(ctx.prisma);
    const result = await repo.claimTarget({
      merchantId: payload.merchantId,
      campaignId: payload.campaignId,
      messageId: payload.messageId,
      customerId: payload.customerId,
    });

    if (result === 'already_claimed') {
      log.info(
        {
          jobId: job.id,
          merchantId: payload.merchantId,
          messageId: payload.messageId,
          campaignId: payload.campaignId,
        },
        'dispatch: target already claimed (idempotent replay/race); no-op',
      );
      return;
    }

    log.info(
      {
        jobId: job.id,
        merchantId: payload.merchantId,
        messageId: payload.messageId,
        campaignId: payload.campaignId,
        customerId: payload.customerId,
      },
      'dispatch: CampaignTarget claimed (pending); gates + send land in later batches',
    );
  });
}

/**
 * Factory. Wired into `apps/drainer/src/index.ts` (boot alongside the outbox
 * drain + AI Workers, close in parallel on SIGTERM/SIGINT).
 *
 * Connection rule: every Worker has its OWN ioredis connection (Workers use
 * blocking commands; a shared connection would stall). See
 * `packages/queue/src/redis-client.ts` header.
 */
export function createDispatchWorker(
  ctx: DrainerContext,
): Worker<CampaignDispatchJobPayload> {
  const connection = createRedisClient('worker.campaign-dispatch');

  const worker = new Worker<CampaignDispatchJobPayload>(
    QUEUE_NAMES.campaign.dispatch,
    async (job: Job<CampaignDispatchJobPayload>) => {
      await processCampaignDispatchJob(ctx, job);
    },
    {
      connection,
      concurrency: WORKER_CONCURRENCY,
      lockDuration: WORKER_LOCK_DURATION_MS,
    },
  );

  worker.on('failed', (job, err) => {
    log.error(
      {
        jobId: job?.id,
        merchantId: job?.data.merchantId,
        messageId: job?.data.messageId,
        attemptsMade: job?.attemptsMade,
        err: err.message,
      },
      'dispatch worker: job failed (BullMQ retries per attempts:3; an exhausted job is re-picked by the next 15-min dispatch sweep)',
    );
  });

  worker.on('error', (err) => {
    log.error({ err: err.message }, 'dispatch worker: top-level error');
  });

  return worker;
}
