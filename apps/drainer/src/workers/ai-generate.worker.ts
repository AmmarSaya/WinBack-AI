/**
 * AI Worker — BullMQ consumer for the `ai.generate` queue (Epic F §F-8).
 *
 * Counterpart to the `customer.state_changed` drainer handler (Step 2b
 * — `apps/drainer/src/handlers/customer-state-changed.ts`). Runs as a
 * SECOND BullMQ Worker INSIDE `apps/drainer` (same process as the outbox
 * drainer, separate Worker instance on the `ai.generate` queue). Step
 * 2d wires construction + lifecycle into `apps/drainer/src/index.ts`
 * (boot alongside the outbox drain Worker, close in parallel on
 * SIGTERM/SIGINT).
 *
 * Locked Q-decisions (from batch 4 Phase 1 + the Step 2c follow-up
 * audit answered Q-A1 through Q-A4):
 *
 *   - Q-D4  : concurrency = 1 (GLOBAL, not per-merchant — OSS BullMQ
 *             has no `groupLimit`; per-merchant tuning deferred to M10).
 *   - Q-A1  : 3-retries-exhausted audit DEFERRED to M10 stale-pending
 *             sweep. No `worker.on('failed')` audit emission in v1.
 *             Operator surface for exhausted-retry rows is
 *             `WHERE status='pending' AND createdAt < now() - 1 hour`.
 *             Reason: emitting from the BullMQ failed-event listener
 *             would require re-deriving tenant scope outside any
 *             AsyncLocalStorage context — attack surface vs forensic
 *             value isn't worth it before the M10 sweep ships.
 *   - Q-A2  : Unknown (non-AiProviderError) errors → RE-THROW to BullMQ.
 *             Conservative — closing the row on an error we don't
 *             understand may mask real bugs in our SDK mapper and blocks
 *             operator recovery on the next deploy. After 3 retries the
 *             job lands in BullMQ's failed-jobs queue with the original
 *             stack; operator can replay or markFailed manually.
 *   - Q-A3  : AuditLog.context shape on the non-retryable error path:
 *             { providerErrorCode, jobId, attempt, errorMessage }. The
 *             errorMessage is truncated to 500 chars (half the
 *             markFailed.lastError ceiling — the context holds multiple
 *             keys, so each budgets less).
 *   - Q-A4  : Step 2c surfaces NO changes to `index.ts` or `dispatch.ts`.
 *             Only this worker file + its tests. Step 2d wires boot.
 *
 * Job flow (per §F-8 + §F-Q7 atomicity contract):
 *
 *   1. `withTenantScope(payload.merchantId, ...)` wraps the entire body.
 *      Every Prisma read/write below is tenant-asserted + auto-injected
 *      by the extension (`packages/db/src/extensions/hooks.ts`).
 *
 *   2. IDEMPOTENT PICKUP — read `AiGeneration` row + `merchant.shop` in
 *      one findUnique. Bail if:
 *        - row === null     → cascade race (customer redacted) OR
 *                              cross-tenant payload safety (the tenant-
 *                              scoped read filtered out a row belonging
 *                              to a DIFFERENT merchant — third layer of
 *                              defence-in-depth: contracts validate
 *                              payload, extension injects merchantId,
 *                              worker no-ops on null).
 *        - status !== pending → idempotent replay (BullMQ stalled-job
 *                                re-pickup, manual replay). NO provider
 *                                call, NO tx, NO audit.
 *
 *   3. PROVIDER CALL — OUTSIDE any `prisma.$transaction` (locked rule:
 *      no external HTTP inside a Postgres tx — provider timeouts would
 *      hold the tx open). `selectActiveProvider` is lazy + memoised on
 *      the AiConfig reference per `packages/ai/src/providers/index.ts`.
 *      Wrapped in try/catch; thrown errors routed to
 *      `handleProviderError`.
 *
 *   4. ERROR PATHS (in `handleProviderError`):
 *        - !instanceof AiProviderError → re-throw (Q-A2).
 *        - AiProviderError && retryable===true  → re-throw (BullMQ
 *          retries via the handler's `attempts:3` + exponential backoff).
 *        - AiProviderError && retryable===false → markFailed + AuditLog
 *          append, BOTH in one tx (ARCHITECTURE rule #14 — audit-in-
 *          same-tx as the state transition it records).
 *      Audit ACTION discriminant:
 *        - AiProviderContentBlockedError → AUDIT_ACTIONS.ai.content_blocked
 *        - AiProviderAuthError /
 *          AiProviderInvalidRequestError → AUDIT_ACTIONS.ai.generation_failed
 *
 *   5. COMPLETION TX — §F-Q7 3-write atomicity:
 *        a. markCompleted (atomic UPDATE WHERE status='pending').
 *        b. RACE-REPLAY GUARD — if `updatedCount === 0`, another worker
 *           already completed this row between our pickup-read and
 *           tx-open. Skip steps c + d; outer tx commits clean (no
 *           rollback, no thrown error). The provider call we just made
 *           is wasted spend, but double-incrementing the spend bucket
 *           would corrupt the forensic record.
 *        c. updateGeneratedText (denormalised Message echo — Epic G's
 *           dispatch worker reads from Message, not AiGeneration).
 *        d. incrementSpend (today's AiSpendBucket).
 */

import type { Prisma } from '@prisma/client';
import {
  AiProviderContentBlockedError,
  AiProviderError,
  estimateCostMicrocents,
  getAiConfig,
  selectActiveProvider,
} from '@winback/ai';
import { AUDIT_ACTIONS, QUEUE_NAMES } from '@winback/contracts';
import {
  AiGenerationRepository,
  AiSpendBucketRepository,
  AuditLogRepository,
  MessageRepository,
  withTenantScope,
} from '@winback/db';
import { getLogger } from '@winback/logger';
import { createRedisClient } from '@winback/queue';
import { Worker, type Job } from 'bullmq';

import type { DrainerContext } from '../context.js';

const log = getLogger('drainer.worker.ai-generate');

/** Q-D4: global concurrency = 1 (OSS BullMQ has no per-merchant groupLimit). */
const WORKER_CONCURRENCY = 1;

/** 30 min — LLM call latency + up-to-3 BullMQ retry delays fit comfortably. */
const WORKER_LOCK_DURATION_MS = 30 * 60 * 1000;

/**
 * Q-A3 — truncation ceiling for `AuditLog.context.errorMessage`. Half
 * of `AiGenerationRepository.markFailed.lastError` (1000) because the
 * audit context holds several keys; each one budgets less.
 */
const AUDIT_ERROR_MESSAGE_MAX_CHARS = 500;

/**
 * Job payload — set by `handleCustomerStateChanged` (Step 2b) at enqueue
 * time. BullMQ jobId = `aiGenerationId` per §F-8 idempotent-replay
 * contract.
 */
export interface AiGenerateJobPayload {
  readonly aiGenerationId: string;
  readonly merchantId: string;
  readonly customerId: string;
}

/**
 * Single-job processor. Exported separately from the factory so unit
 * tests drive the flow with a synthetic Job<AiGenerateJobPayload>
 * without standing up a real BullMQ Worker (which needs Redis).
 */
export async function processAiGenerateJob(
  ctx: DrainerContext,
  job: Job<AiGenerateJobPayload>,
): Promise<void> {
  const payload = job.data;

  await withTenantScope(payload.merchantId, async () => {
    // STEP 1 — IDEMPOTENT PICKUP. AiGeneration + merchant.shop in one
    // findUnique (avoids a second roundtrip on the error path).
    //
    // SECURITY: this read flows through the Prisma extension's tenant-
    // scoped read hook (`packages/db/src/extensions/hooks.ts`), which
    // injects `WHERE merchantId = <active-scope-merchantId>`. A
    // malicious or buggy job payload carrying an aiGenerationId that
    // belongs to a DIFFERENT merchant gets filtered → findUnique returns
    // null → worker no-ops. Third layer of defence-in-depth (the first
    // is the contracts-validated payload shape from Step 2b's handler;
    // the second is the extension's tenant injection here).
    const row = await ctx.prisma.aiGeneration.findUnique({
      where: { id: payload.aiGenerationId },
      select: {
        status: true,
        provider: true,
        modelId: true,
        systemPrompt: true,
        userPrompt: true,
        merchant: { select: { shop: true } },
      },
    });
    if (row === null) {
      log.warn(
        {
          jobId: job.id,
          aiGenerationId: payload.aiGenerationId,
          merchantId: payload.merchantId,
          customerId: payload.customerId,
        },
        'ai-generate: AiGeneration row not found under active tenant scope (cascade race OR cross-tenant payload); no-op',
      );
      return;
    }
    if (row.status !== 'pending') {
      log.info(
        {
          jobId: job.id,
          aiGenerationId: payload.aiGenerationId,
          merchantId: payload.merchantId,
          status: row.status,
        },
        'ai-generate: row already terminal (idempotent replay); no provider call, no tx, no audit',
      );
      return;
    }
    const shop = row.merchant.shop;

    // STEP 2 — PROVIDER CALL. OUTSIDE any prisma.$transaction (locked
    // rule: no external HTTP inside a Postgres tx). `selectActiveProvider`
    // is lazy + memoised on the AiConfig reference; only the active
    // provider is instantiated (per L6 in packages/ai/providers/index.ts).
    const aiConfig = getAiConfig();
    const provider = selectActiveProvider(aiConfig);
    let result;
    try {
      result = await provider.generate({
        model: row.modelId,
        systemPrompt: row.systemPrompt,
        userPrompt: row.userPrompt,
        maxTokens: aiConfig.AI_MAX_TOKENS,
        temperature: aiConfig.AI_TEMPERATURE,
      });
    } catch (err) {
      await handleProviderError(ctx, job, payload, shop, err);
      return;
    }

    // STEP 3 — COST from ACTUAL token counts (not the handler's worst-
    // case ceiling estimate used for the pre-flight cap check). BigInt
    // MICROCENTS throughout — ARCHITECTURE rule #2.
    const costMicrocents = estimateCostMicrocents(
      aiConfig.AI_PROVIDER,
      aiConfig.AI_MODEL,
      result.inputTokens,
      result.outputTokens,
    );

    // STEP 4 — 3-WRITE COMPLETION TX (§F-Q7 atomicity lock).
    await ctx.prisma.$transaction(async (extendedTx) => {
      // Prisma 5 typing gap — same cast pattern as the Step 2b handler
      // (customer-state-changed.ts:361) and the install/customer/order
      // handlers. Runtime extension hooks fire on `extendedTx`; only
      // the static type differs.
      const tx = extendedTx as unknown as Prisma.TransactionClient;

      const aiGenRepo = new AiGenerationRepository(ctx.prisma);
      const completed = await aiGenRepo.markCompleted(
        {
          aiGenerationId: payload.aiGenerationId,
          generatedText: result.content,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          totalTokens: result.totalTokens,
          latencyMs: result.latencyMs,
          costMicrocents,
        },
        tx,
      );

      // ── RACE-REPLAY GUARD ───────────────────────────────────────────
      // `markCompleted` is `updateMany WHERE id = $1 AND status =
      // 'pending'`. updatedCount === 0 means another worker (or a
      // BullMQ stalled-job re-pickup) already transitioned this row out
      // of pending between our STEP 1 pickup-read and this tx-open. The
      // provider call we just made is wasted spend, but writing the
      // second copy of generatedText + double-incrementing today's
      // spend bucket would corrupt the forensic record. Early-exit;
      // outer tx commits clean (no rollback, no thrown error).
      //
      // This is the user-mandated regression contract from
      // handoff.md (Step 2c regression #2). The early-exit MUST surface
      // in the diff with this comment block so future readers understand
      // why updatedCount gates the rest of the tx.
      if (completed.updatedCount === 0) {
        log.warn(
          {
            jobId: job.id,
            aiGenerationId: payload.aiGenerationId,
            merchantId: payload.merchantId,
          },
          'ai-generate: markCompleted updatedCount=0 (race-replay); skipping updateGeneratedText + incrementSpend; tx commits clean',
        );
        return;
      }

      const messageRepo = new MessageRepository(ctx.prisma);
      await messageRepo.updateGeneratedText(
        {
          aiGenerationId: payload.aiGenerationId,
          generatedText: result.content,
        },
        tx,
      );

      const spendBucketRepo = new AiSpendBucketRepository(ctx.prisma);
      await spendBucketRepo.incrementSpend(
        {
          merchantId: payload.merchantId,
          date: new Date(),
          deltaMicrocents: costMicrocents,
        },
        tx,
      );
    });

    log.info(
      {
        jobId: job.id,
        aiGenerationId: payload.aiGenerationId,
        merchantId: payload.merchantId,
        customerId: payload.customerId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        totalTokens: result.totalTokens,
        latencyMs: result.latencyMs,
        // BigInt JSON boundary (rule #19) — pino serializer would throw
        // on bigint; stringify at the boundary.
        costMicrocents: costMicrocents.toString(),
        provider: aiConfig.AI_PROVIDER,
        model: aiConfig.AI_MODEL,
      },
      'ai-generate: completed (3-write tx)',
    );
  });
}

/**
 * Classifies a thrown error from `provider.generate(...)` and routes to
 * the appropriate path:
 *
 *   - Unknown class (not AiProviderError) → re-throw (Q-A2).
 *   - AiProviderError && retryable===true  → re-throw (BullMQ retries).
 *   - AiProviderError && retryable===false → markFailed + AuditLog
 *     append in one tx (ARCHITECTURE rule #14).
 *
 * The audit action:
 *   - AiProviderContentBlockedError → AUDIT_ACTIONS.ai.content_blocked
 *   - AiProviderAuthError or
 *     AiProviderInvalidRequestError → AUDIT_ACTIONS.ai.generation_failed
 */
async function handleProviderError(
  ctx: DrainerContext,
  job: Job<AiGenerateJobPayload>,
  payload: AiGenerateJobPayload,
  shop: string,
  err: unknown,
): Promise<void> {
  if (!(err instanceof AiProviderError)) {
    // Q-A2: re-throw. BullMQ retries 3× then surfaces the original
    // stack in the failed-jobs queue. Closing the row here would risk
    // hiding real bugs in our SDK mapper.
    log.error(
      {
        jobId: job.id,
        aiGenerationId: payload.aiGenerationId,
        merchantId: payload.merchantId,
        err,
      },
      'ai-generate: unknown error class (not AiProviderError); re-throwing to BullMQ',
    );
    throw err;
  }

  if (err.retryable) {
    // Q-A1: no audit on retryable failure or final exhaustion in v1.
    // Operator surface for exhausted-retry rows is the stale-pending
    // query (M10 sweep cron formalises it).
    log.warn(
      {
        jobId: job.id,
        aiGenerationId: payload.aiGenerationId,
        merchantId: payload.merchantId,
        providerErrorCode: err.code,
        attempt: job.attemptsMade,
      },
      'ai-generate: retryable provider error; re-throwing (BullMQ delay-retries)',
    );
    throw err;
  }

  const action =
    err instanceof AiProviderContentBlockedError
      ? AUDIT_ACTIONS.ai.content_blocked
      : AUDIT_ACTIONS.ai.generation_failed;

  await ctx.prisma.$transaction(async (extendedTx) => {
    const tx = extendedTx as unknown as Prisma.TransactionClient;

    const aiGenRepo = new AiGenerationRepository(ctx.prisma);
    await aiGenRepo.markFailed(
      {
        aiGenerationId: payload.aiGenerationId,
        lastError: err.code,
      },
      tx,
    );

    const auditLogRepo = new AuditLogRepository(ctx.prisma);
    await auditLogRepo.append(
      {
        merchantId: payload.merchantId,
        shop,
        actorType: 'system',
        actorId: 'drainer',
        action,
        targetType: 'ai_generation',
        targetId: payload.aiGenerationId,
        // Q-A3-approved shape. jobId per §F-8 equals aiGenerationId,
        // but we include it explicitly for forensic dedupe across
        // drainer crashes between provider call + tx open. errorMessage
        // truncated to 500 chars.
        context: {
          providerErrorCode: err.code,
          jobId: job.id ?? null,
          attempt: job.attemptsMade,
          errorMessage: truncateErrorMessage(err.message),
        },
      },
      tx,
    );
  });

  log.warn(
    {
      jobId: job.id,
      aiGenerationId: payload.aiGenerationId,
      merchantId: payload.merchantId,
      providerErrorCode: err.code,
      action,
    },
    'ai-generate: non-retryable provider error; markFailed + audit (one tx)',
  );
}

function truncateErrorMessage(message: string): string {
  if (message.length <= AUDIT_ERROR_MESSAGE_MAX_CHARS) return message;
  return message.slice(0, AUDIT_ERROR_MESSAGE_MAX_CHARS);
}

/**
 * Factory. Step 2d wires construction + lifecycle in
 * `apps/drainer/src/index.ts` (boot alongside the outbox drain Worker,
 * close in parallel on SIGTERM/SIGINT).
 *
 * Connection rule: every Worker has its OWN ioredis connection
 * (Workers use blocking commands; shared connections would stall). See
 * `packages/queue/src/redis-client.ts` header.
 */
export function createAiGenerateWorker(
  ctx: DrainerContext,
): Worker<AiGenerateJobPayload> {
  const connection = createRedisClient('worker.ai-generate');

  const worker = new Worker<AiGenerateJobPayload>(
    QUEUE_NAMES.ai.generate,
    async (job: Job<AiGenerateJobPayload>) => {
      await processAiGenerateJob(ctx, job);
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
        aiGenerationId: job?.data?.aiGenerationId,
        merchantId: job?.data?.merchantId,
        attemptsMade: job?.attemptsMade,
        err: err.message,
      },
      'ai-generate worker: job failed (BullMQ retry policy applies; Q-A1 defers exhaustion audit to M10)',
    );
  });

  worker.on('error', (err) => {
    log.error({ err: err.message }, 'ai-generate worker: top-level error');
  });

  return worker;
}
