/**
 * Dispatch Worker — BullMQ consumer for the `campaign.dispatch` queue
 * (Epic G batch 8.2 — the dispatch skeleton's CONSUMER half).
 *
 * Runs as a THIRD BullMQ Worker INSIDE `apps/drainer` (alongside the outbox
 * drain Worker and the AI Worker, each a separate Worker instance with its own
 * ioredis connection). The producer is the scheduler's 15-min `dispatch-sweep`
 * tick, which enqueues one job per dispatch-eligible draft.
 *
 * WHAT IT DOES (8.3 — one pass): CLAIM (idempotent) → REPLAY GUARD → GATE CHAIN
 * → apply the outcome.
 *   1. `claimTarget` — a fresh draft (arm 1) creates the `CampaignTarget`
 *      (pending); a re-entered deferred target (arm 2) is `already_claimed` and
 *      we proceed to RE-GATE it. The result is discarded — both mean "the
 *      target now exists."
 *   2. `loadDispatchContext` → null means the target is gone (GDPR redact
 *      cascade-deleted it) → no-op. The REPLAY GUARD then short-circuits a
 *      target already in {suppressed, sent, failed} BEFORE any gate runs (a
 *      duplicate/stale job does NO gate work).
 *   3. `runGateChain` — the 6 gates, terminal-before-transient, short-circuit.
 *   4. Apply: `suppressed(gate)` → `resolveTerminal` (CampaignTarget + Message
 *      both → suppressed, in one tx); `deferred(gate)` → `deferTarget`
 *      (status=deferred, the sweep's arm 2 re-evaluates next tick); `passed` →
 *      a logged SEND-STUB (8.4 inserts the real send), target stays `pending`.
 *
 * WHAT IT DOES NOT DO (8.4): NO ESP send, NO `MessageEvent`, NO authoritative
 * under-lock quota increment (gate 6 is pre-flight only). A `passed` target
 * waits at `pending` for 8.4 to append the send to this same pass.
 *
 * IDEMPOTENCY: the claim is idempotent on `CampaignTarget.messageId @unique`;
 * the replay guard makes re-processing a terminal target a no-op;
 * `resolveTerminal`/`deferTarget` are guarded on `status IN (pending,deferred)`.
 * No BullMQ jobId dedup (it would risk a failed-job-wedge under
 * `removeOnComplete`).
 *
 * RETRY: jobs carry `attempts: 3` + backoff. An exhausted job is re-picked by
 * the next 15-min dispatch sweep (a still-unclaimed draft via arm 1, or a
 * `deferred` target via arm 2).
 */

import {
  type CampaignDispatchJobPayload,
  QUEUE_NAMES,
} from '@winback/contracts';
import {
  CampaignRepository,
  MessageRepository,
  OrderRepository,
  withTenantScope,
} from '@winback/db';
import { getLogger } from '@winback/logger';
import { createRedisClient } from '@winback/queue';
import { Worker, type Job } from 'bullmq';

import type { DrainerContext } from '../context.js';
import { runGateChain } from '../dispatch/gate-chain.js';

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
  const { merchantId, messageId } = payload;
  const logBase = { jobId: job.id, merchantId, messageId, campaignId: payload.campaignId };

  await withTenantScope(merchantId, async () => {
    const campaignRepo = new CampaignRepository(ctx.prisma);
    const orderRepo = new OrderRepository(ctx.prisma);
    const messageRepo = new MessageRepository(ctx.prisma);

    // 1. CLAIM (idempotent). Fresh draft → creates the pending target;
    //    re-entered deferred target → already_claimed. Either way the target
    //    now exists; the result is intentionally discarded (8.3 re-gates a
    //    re-entered target, unlike the 8.2 skeleton which returned here).
    await campaignRepo.claimTarget({
      merchantId,
      campaignId: payload.campaignId,
      messageId,
      customerId: payload.customerId,
    });

    // 2. LOAD CONTEXT + REPLAY GUARD.
    const dctx = await campaignRepo.loadDispatchContext({ messageId });
    if (dctx === null) {
      log.info(logBase, 'dispatch: target gone (GDPR redact cascade?) or settings missing; no-op');
      return;
    }
    // The target reached a terminal/sent state already (duplicate or stale job)
    // — do NO gate work. Short-circuits BEFORE any gate read.
    if (
      dctx.targetStatus === 'suppressed' ||
      dctx.targetStatus === 'sent' ||
      dctx.targetStatus === 'failed'
    ) {
      log.info(
        { ...logBase, targetStatus: dctx.targetStatus },
        'dispatch: target already terminal (replay guard); no gate work',
      );
      return;
    }

    // 3. GATE CHAIN.
    const outcome = await runGateChain(
      { campaignRepo, orderRepo, messageRepo, now: new Date() },
      { merchantId, ctx: dctx },
    );

    // 4. APPLY OUTCOME.
    if (outcome.kind === 'suppressed') {
      const { resolved } = await campaignRepo.resolveTerminal({ messageId, reason: outcome.gate });
      log.info(
        { ...logBase, gate: outcome.gate, resolved },
        'dispatch: suppressed by terminal gate (CampaignTarget + Message → suppressed)',
      );
      return;
    }

    if (outcome.kind === 'deferred') {
      await campaignRepo.deferTarget({ messageId });
      log.info(
        { ...logBase, gate: outcome.gate },
        'dispatch: deferred by transient gate; the 15-min sweep (arm 2) re-evaluates',
      );
      return;
    }

    // passed — 8.3 boundary: no send yet. 8.4 appends the send here.
    log.info(
      { ...logBase, customerId: payload.customerId },
      'dispatch: passed all gates — SEND STUB (8.4 sends); target stays pending',
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
