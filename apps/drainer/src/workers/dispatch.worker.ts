/**
 * Dispatch Worker — BullMQ consumer for the `campaign.dispatch` queue
 * (Epic G batch 8.2 — the dispatch skeleton's CONSUMER half; batch 8.3 — the
 * gate chain over claimed targets; batch 8.4 — the SES send + completion-tx).
 *
 * Runs as a THIRD BullMQ Worker INSIDE `apps/drainer` (alongside the outbox
 * drain Worker and the AI Worker, each a separate Worker instance with its own
 * ioredis connection). The producer is the scheduler's 15-min `dispatch-sweep`
 * tick, which enqueues one job per dispatch-eligible draft.
 *
 * WHAT IT DOES (8.4 — one pass): CLAIM (idempotent) → REPLAY GUARD → GATE CHAIN
 * → if `passed`: pre-send tombstone → external SES send → in-tx-retry
 *   completion-tx (under-lock quota increment + sending→sent CAS + Message
 *   advance + dispatch.sent audit, ALL in one tx via the SHARED repo method
 *   that 8.5's SNS handler will ALSO call).
 *
 *   1. `claimTarget` — a fresh draft (arm 1) creates the `CampaignTarget`
 *      (pending); a re-entered deferred target (arm 2) is `already_claimed` and
 *      we proceed to RE-GATE it.
 *   2. `loadDispatchContext` → null means the target is gone (GDPR redact
 *      cascade-deleted it) → no-op. The REPLAY GUARD then short-circuits a
 *      target already in {suppressed, sent, failed, SENDING (8.4)} BEFORE any
 *      gate runs. Including `sending` in the guard is the LOAD-BEARING
 *      ACK-LOST safety: a row in `sending` means a prior pass either sent
 *      successfully (and crashed before recording it) or is in the
 *      microsecond C1' window. NEVER auto-resend.
 *   3. `runGateChain` — the 6 gates, terminal-before-transient, short-circuit.
 *   4. Apply non-`passed` outcomes: `suppressed(gate)` → `resolveTerminal`
 *      (default status='suppressed'); `deferred(gate)` → `deferTarget`.
 *   5. `passed` → SES send (8.4):
 *      a. `startSending` flips pending → sending in its own committed tx.
 *      b. `emailProvider.send(...)` — external HTTP, OUTSIDE any tx.
 *      c. On a RETRYABLE error (`EmailProviderError.retryable === true`):
 *         `revertToPending` flips sending → pending (the worker-flow fix)
 *         then THROW. BullMQ retries; the next attempt re-enters cleanly via
 *         a fresh `startSending`. Without revertToPending, the replay guard
 *         would catch the retry and the row would stick forever.
 *      d. On a NON-RETRYABLE error: `resolveTerminal({status:'failed'})` (or
 *         `'suppressed'` for `email_recipient_suppressed`) + `dispatch.
 *         suppressed_by_ses` audit for the SES-suppression path.
 *      e. On success: `markSentWithQuota` — SHARED completion-tx (worker
 *         happy path + 8.5 SNS handler call the same method). In-tx-retry
 *         budget of 3 attempts at 100ms spacing GUARDS against a transient
 *         DB blip causing C3 (SES sent, completion lost). Budget-exhausted
 *         does NOT throw — letting BullMQ retry would hit the replay guard
 *         and the completion would be permanently lost; instead we accept
 *         C3 and let 8.5's SNS handler reconcile.
 *
 * IDEMPOTENCY (across the full chain):
 *   - claim is idempotent on `CampaignTarget.messageId @unique`.
 *   - replay guard makes re-processing terminal/sending targets a no-op.
 *   - startSending is CAS-guarded (status='pending').
 *   - markSentWithQuota CASes target sending→sent and Message draft→sent;
 *     a race-loser's tx rolls back without double-incrementing the bucket.
 *   - revertToPending is CAS-guarded (status='sending') — never resurrects
 *     a terminal row.
 *
 * RETRY: jobs carry `attempts: 3` + backoff. A retryable SES error rethrows;
 * a non-retryable does not. An exhausted-retries job (or any unhandled throw)
 * is re-picked by the next 15-min dispatch sweep — but only via arm 1 (fresh
 * draft) or arm 2 (deferred). A `sending` row is invisible to both arms
 * (arm 1's NOT EXISTS / arm 2's status=deferred), so it does NOT auto-resend.
 */

import {
  AUDIT_ACTIONS,
  type CampaignDispatchJobPayload,
  QUEUE_NAMES,
} from '@winback/contracts';
import {
  AuditLogRepository,
  CampaignRepository,
  MessageRepository,
  OrderRepository,
  withTenantScope,
} from '@winback/db';
import { EmailProviderError } from '@winback/email';
import { getLogger } from '@winback/logger';
import { createRedisClient } from '@winback/queue';
import { Worker, type Job } from 'bullmq';

import type { DrainerContext } from '../context.js';
import { runGateChain } from '../dispatch/gate-chain.js';

/**
 * In-tx-retry budget for the completion-tx (Phase 1 §3 / Phase 2 §6 fix).
 *
 * RATIONALE: the completion-tx runs AFTER the external SES send returns.
 * If it fails with a transient DB error (lock timeout, connection blip),
 * we MUST retry in-pass — letting BullMQ retry the whole worker pass would
 * hit the replay guard (`sending`) and the completion would be silently
 * LOST forever. The `providerMessageId` is on the worker's stack right now;
 * a fresh BullMQ attempt would start without it.
 *
 * Budget exhaustion → log + accept C3 outcome (8.5 SNS handler reconciles
 * via the same shared method). Do NOT throw — see preamble.
 */
const COMPLETION_TX_RETRIES = 3;
const COMPLETION_TX_RETRY_DELAY_MS = 100;

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
    // OR is `sending` (8.4 ACK-LOST safety: a row in `sending` is either a
    // crash-window remnant or a parallel in-flight send — NEVER auto-resend).
    // Short-circuits BEFORE any gate read.
    if (
      dctx.targetStatus === 'suppressed' ||
      dctx.targetStatus === 'sent' ||
      dctx.targetStatus === 'failed' ||
      dctx.targetStatus === 'sending'
    ) {
      log.info(
        { ...logBase, targetStatus: dctx.targetStatus },
        'dispatch: target already terminal-or-sending (replay guard); no gate work',
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

    // 5. PASSED — 8.4 SES send + completion-tx.
    if (dctx.customerEmail === null || dctx.customerEmail === '') {
      // No address ingested. Defer rather than terminalise — a future
      // customer-update webhook may populate the address. NB: gate 2
      // (consent) already filtered out customers without subscribed
      // consent; a missing address with subscribed consent is an unusual
      // mid-state that warrants a deferral, not a failure burn.
      await campaignRepo.deferTarget({ messageId });
      log.warn(
        logBase,
        'dispatch: passed gates but customer email is null — deferring (await consent/email re-ingest)',
      );
      return;
    }

    // 5a. Pre-send tx (pending → sending).
    const now = new Date();
    const startResult = await campaignRepo.startSending({ messageId, now });
    if (startResult.kind === 'noop_target_missing') {
      log.info(logBase, 'dispatch: target vanished between gate chain and pre-send; no-op');
      return;
    }
    if (startResult.kind === 'noop_not_pending') {
      log.info(
        { ...logBase, currentStatus: startResult.currentStatus },
        'dispatch: pre-send race lost (another worker advanced the target); no-op',
      );
      return;
    }

    // 5b. External SES send (OUTSIDE any tx — locked rule).
    let accepted: { providerMessageId: string; latencyMs: number };
    try {
      accepted = await ctx.emailProvider.send({
        from: ctx.emailFromAddress,
        to: dctx.customerEmail,
        subject: deriveSubject(),
        html: dctx.generatedText,
        correlationId: messageId,
        ...(ctx.emailConfigurationSetName !== undefined
          ? { configurationSetName: ctx.emailConfigurationSetName }
          : {}),
      });
    } catch (err) {
      await handleSesError(ctx, campaignRepo, dctx, payload, logBase, err);
      return;
    }

    // 5c. Completion-tx with in-pass retry budget (NEW load-bearing concept —
    // see header). Budget exhaustion = accept C3 + log + return without
    // throwing (preserves the no-auto-resend invariant).
    let completion:
      | { kind: 'sent' }
      | { kind: 'noop_already_terminal'; currentStatus: string }
      | null = null;
    let lastTxError: unknown = null;
    for (let attempt = 1; attempt <= COMPLETION_TX_RETRIES; attempt += 1) {
      try {
        completion = await campaignRepo.markSentWithQuota({
          messageId,
          merchantId,
          shop: dctx.shop,
          campaignId: payload.campaignId,
          customerId: payload.customerId,
          providerMessageId: accepted.providerMessageId,
          now,
        });
        break;
      } catch (err) {
        lastTxError = err;
        log.warn(
          {
            ...logBase,
            attempt,
            attemptsRemaining: COMPLETION_TX_RETRIES - attempt,
            providerMessageId: accepted.providerMessageId,
            err: err instanceof Error ? err.message : String(err),
          },
          'dispatch: completion-tx attempt failed; in-pass retry budget engaged',
        );
        if (attempt < COMPLETION_TX_RETRIES) {
          await sleep(COMPLETION_TX_RETRY_DELAY_MS);
        }
      }
    }

    if (completion === null) {
      // Budget exhausted. SES already sent — accept C3. The row stays at
      // `sending` awaiting 8.5's SNS Delivery handler to reconcile (or
      // operator rescue per OPERATIONS.md). Do NOT throw — letting BullMQ
      // retry would hit the replay guard and the completion would be
      // permanently lost.
      log.error(
        {
          ...logBase,
          providerMessageId: accepted.providerMessageId,
          err: lastTxError instanceof Error ? lastTxError.message : String(lastTxError),
        },
        'dispatch: completion-tx exhausted in-pass retries — accepting C3 (row stays sending; 8.5 SNS reconciles)',
      );
      return;
    }

    if (completion.kind === 'noop_already_terminal') {
      // The CampaignTarget was no longer `sending` when the completion-tx
      // ran — the only way that's possible is a parallel SNS reconcile (8.5)
      // or a manual operator action. SES already sent on our side; the row
      // has the right terminal state via the other path. Log + return.
      log.warn(
        {
          ...logBase,
          providerMessageId: accepted.providerMessageId,
          currentStatus: completion.currentStatus,
        },
        'dispatch: completion-tx found row already terminal (race with 8.5 SNS / manual); no-op',
      );
      return;
    }

    log.info(
      {
        ...logBase,
        customerId: payload.customerId,
        providerMessageId: accepted.providerMessageId,
        latencyMs: accepted.latencyMs,
      },
      'dispatch: sent via SES (CampaignTarget + Message → sent; bucket++; dispatch.sent audit)',
    );
  });
}

/**
 * Maps a SES failure to the right side-effect:
 *   - RETRYABLE → revertToPending + THROW (BullMQ retries; replay guard
 *     would otherwise catch the retry — see header).
 *   - email_recipient_suppressed → resolveTerminal(suppressed,
 *     'ses_suppressed') + write `dispatch.suppressed_by_ses` AuditLog.
 *     **Does NOT write a Suppression row** — deferred to 8.5's unified path.
 *   - Other non-retryable EmailProviderError → resolveTerminal(failed,
 *     <error code>) — burned draft; Message also flips to 'failed'.
 *   - Unknown non-Error throw → revertToPending + rethrow as transient.
 */
async function handleSesError(
  ctx: DrainerContext,
  campaignRepo: CampaignRepository,
  dctx: { customerEmail: string | null; shop: string },
  payload: CampaignDispatchJobPayload,
  logBase: Record<string, unknown>,
  err: unknown,
): Promise<void> {
  if (err instanceof EmailProviderError) {
    if (err.retryable) {
      // The WORKER-FLOW FIX — revert sending → pending so BullMQ's retry
      // re-enters the send path cleanly via a fresh startSending. Without
      // this, the replay guard would short-circuit the retry and the row
      // would stick forever.
      await campaignRepo.revertToPending({ messageId: payload.messageId });
      log.warn(
        { ...logBase, errCode: err.code },
        'dispatch: SES retryable error — reverted sending→pending; throwing for BullMQ retry',
      );
      throw err;
    }

    if (err.code === 'email_recipient_suppressed') {
      // Terminal-only per Phase 1 sharpening A — DO NOT write a Suppression
      // row here. 8.5's unified path owns Suppression writes (CSV import +
      // SNS bounces/complaints + this case).
      await campaignRepo.resolveTerminal({
        messageId: payload.messageId,
        reason: 'ses_suppressed',
        status: 'suppressed',
      });
      const auditLogRepo = new AuditLogRepository(ctx.prisma);
      await auditLogRepo.append({
        merchantId: payload.merchantId,
        shop: dctx.shop,
        actorType: 'system',
        actorId: 'drainer',
        action: AUDIT_ACTIONS.dispatch.suppressed_by_ses,
        targetType: 'campaign_target',
        targetId: payload.messageId,
        context: {
          campaignId: payload.campaignId,
          customerId: payload.customerId,
          errorCode: err.code,
        },
      });
      log.info(
        { ...logBase, errCode: err.code },
        'dispatch: SES recipient suppressed → terminal suppressed + dispatch.suppressed_by_ses audit (NO Suppression row — 8.5 owns)',
      );
      return;
    }

    await campaignRepo.resolveTerminal({
      messageId: payload.messageId,
      reason: err.code,
      status: 'failed',
    });
    log.error(
      { ...logBase, errCode: err.code, errMessage: err.message },
      'dispatch: SES non-retryable failure → terminal failed (CampaignTarget + Message)',
    );
    return;
  }

  // Unknown throw class — treat as transient. revertToPending so the retry
  // re-enters cleanly; rethrow so BullMQ retries.
  await campaignRepo.revertToPending({ messageId: payload.messageId });
  log.error(
    { ...logBase, err: err instanceof Error ? err.message : String(err) },
    'dispatch: SES threw unknown error class — reverted sending→pending; rethrowing for BullMQ retry',
  );
  throw err;
}

/**
 * v1 subject derivation. Single-touch winback over email; subject is
 * deliberately static at 8.4 (the Campaign-CRUD UI in 8.6 owns per-campaign
 * customisation). Kept as a function to keep the call site readable + to
 * give 8.6 a single point to refactor.
 */
function deriveSubject(): string {
  return 'We miss you';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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
