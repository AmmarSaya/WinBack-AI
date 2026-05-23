import type { Prisma } from '@prisma/client';
import type { AiProviderName } from '@winback/ai';

import type { WinbackPrisma } from '../client.js';

/**
 * Repository for the `AiGeneration` table — the typed write chokepoint
 * for every LLM call's request/response/cost ledger row.
 *
 * Three methods cover the row's lifecycle:
 *
 *   - `createPending`   — drainer's `customer.state_changed` handler
 *                          writes the row BEFORE enqueueing the
 *                          `ai.generate` BullMQ job (§F-9 step 8a).
 *                          Status = `pending`.
 *   - `markCompleted`   — AI Worker writes the LLM response back to
 *                          the row after a successful call. Idempotent
 *                          on already-completed rows so worker replays
 *                          (BullMQ stalled-job re-pickup, manual replay)
 *                          are no-ops, NOT double-charges. `updateMany`
 *                          with `where: { id, status: 'pending' }`
 *                          makes the atomic + idempotent pattern explicit.
 *   - `markFailed`      — same idempotency pattern; sets `failedAt` +
 *                          truncated `lastError`. Non-retryable failures
 *                          (content filter, spend ceiling, auth) end
 *                          here.
 *
 * Scope semantics. `AiGeneration` is in `TENANT_SCOPED_MODELS` — the
 * Prisma extension auto-injects + asserts `merchantId` on every read
 * and write. Repository methods don't repeat that work. None of these
 * methods carry a documented scope contract that would justify an
 * explicit `getTenantScope` guard at method top (the M-1/C-5 pattern
 * is for methods with a single legitimate caller in a specific scope —
 * these are tenant-scoped, called from the drainer worker which opens
 * `withTenantScope` per job).
 *
 * Transaction handling. Every method takes optional `tx` — when called
 * inside `prisma.$transaction(...)` or `UnitOfWork.run(...)`, joins the
 * surrounding tx; otherwise runs against `this.prisma`. The Epic F
 * batch 4 drainer handler will pass `tx` to all three Epic F repos
 * (`AiGenerationRepository`, `MessageRepository`, `AiSpendBucketRepository`)
 * so create/complete writes are atomic per §F-Q7.
 *
 * Append-only after completion. Once `status` transitions out of
 * `pending`, the row is forensic. No `update` method is provided that
 * would mutate `generatedText`, `costMicrocents`, or any other completed-
 * row field. M10's stale-pending sweep (cron that fails timed-out
 * `pending` rows) will use `markFailed` directly, NOT a new method.
 */
export class AiGenerationRepository {
  constructor(private readonly prisma: WinbackPrisma) {}

  /**
   * Writes a `pending` AiGeneration row. Caller (drainer handler in
   * batch 4) MUST follow up with a BullMQ `ai.generate` job whose
   * payload carries the returned `aiGenerationId`. The row IS the
   * forensic record of the attempt — even if the BullMQ enqueue fails
   * after, the operator can see the orphan via
   * `WHERE status = 'pending' AND createdAt < now() - interval '1 hour'`.
   *
   * Trigger context is a snapshot at generation time. Future RFM
   * recomputes of the same customer do NOT retroactively update these
   * fields — by design per §F-4.
   */
  async createPending(
    args: CreatePendingArgs,
    tx?: Prisma.TransactionClient,
  ): Promise<{ aiGenerationId: string }> {
    const client = tx ?? this.prisma;
    const row = await client.aiGeneration.create({
      data: {
        merchantId: args.merchantId,
        customerId: args.customerId,
        triggerState: args.triggerState,
        previousState: args.previousState,
        rDays: args.rDays,
        fCount: args.fCount,
        mCents: args.mCents,
        currency: args.currency,
        churnRiskScore: args.churnRiskScore,
        provider: args.provider,
        modelId: args.modelId,
        systemPrompt: args.systemPrompt,
        userPrompt: args.userPrompt,
        // status defaults to 'pending' per schema.
        // generatedText, inputTokens, outputTokens, totalTokens,
        // latencyMs, costMicrocents, completedAt all null until
        // markCompleted is called.
      },
      select: { id: true },
    });
    return { aiGenerationId: row.id };
  }

  /**
   * Marks a `pending` AiGeneration as `completed` and writes the LLM
   * response payload (text + token counts + latency + cost).
   *
   * Idempotency: `updateMany` with `where: { id, status: 'pending' }`.
   * A second call against an already-completed row matches zero rows
   * and returns `{ updatedCount: 0 }` — the AI Worker can safely
   * retry without double-incrementing the spend bucket (the worker's
   * own logic checks the returned count before calling
   * `AiSpendBucketRepository.incrementSpend`).
   *
   * `completedAt` is set to `now()` server-side on the same UPDATE.
   */
  async markCompleted(
    args: MarkCompletedArgs,
    tx?: Prisma.TransactionClient,
  ): Promise<{ updatedCount: number }> {
    const client = tx ?? this.prisma;
    const result = await client.aiGeneration.updateMany({
      where: { id: args.aiGenerationId, status: 'pending' },
      data: {
        status: 'completed',
        generatedText: args.generatedText,
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        totalTokens: args.totalTokens,
        latencyMs: args.latencyMs,
        costMicrocents: args.costMicrocents,
        completedAt: new Date(),
      },
    });
    return { updatedCount: result.count };
  }

  /**
   * Marks a `pending` AiGeneration as `failed` and stores the
   * (truncated) error reason.
   *
   * `lastError` is truncated to 1000 characters at the repository
   * boundary. The DB column is `String?` with no length cap, but
   * unbounded growth on retry-then-fail loops would bloat the table.
   * 1000 chars covers every reasonable failure message (provider
   * errors, ZodError summaries, network exceptions); past that a
   * caller is logging an entire stack trace, which belongs in
   * `@winback/logger` output, not the DB row.
   *
   * Idempotency mirrors `markCompleted` — second call against an
   * already-failed (or completed) row is a no-op.
   */
  async markFailed(
    args: MarkFailedArgs,
    tx?: Prisma.TransactionClient,
  ): Promise<{ updatedCount: number }> {
    const client = tx ?? this.prisma;
    const truncated = truncateLastError(args.lastError);
    const result = await client.aiGeneration.updateMany({
      where: { id: args.aiGenerationId, status: 'pending' },
      data: {
        status: 'failed',
        lastError: truncated,
        failedAt: new Date(),
      },
    });
    return { updatedCount: result.count };
  }
}

const LAST_ERROR_MAX_CHARS = 1000;

function truncateLastError(message: string): string {
  if (message.length <= LAST_ERROR_MAX_CHARS) return message;
  return message.slice(0, LAST_ERROR_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// Public argument types
// ---------------------------------------------------------------------------

export interface CreatePendingArgs {
  readonly merchantId: string;
  /** Customer GID (matches `Customer.id` cuid PK). */
  readonly customerId: string;
  /** CustomerStateValue enum string — stored as String per schema (resilient to future enum extension). */
  readonly triggerState: string;
  /** CustomerStateValue enum string — the state we transitioned FROM. */
  readonly previousState: string;
  /** Recency in days (R from RFM). */
  readonly rDays: number;
  /** Frequency count (F from RFM). */
  readonly fCount: number;
  /** Monetary in cents (M from RFM). BigInt per Architecture lock #2. */
  readonly mCents: bigint;
  /** ISO 4217 3-char currency code. */
  readonly currency: string;
  /** Optional churn-risk score (0..1) if the scoring engine produced one. */
  readonly churnRiskScore: number | null;
  /** Provider that will be called. Typed union from @winback/ai (Q3 lock). */
  readonly provider: AiProviderName;
  /** Provider-specific model identifier (e.g. 'deepseek-v4-flash'). */
  readonly modelId: string;
  /** System prompt sent to the LLM. Stored for auditability + regression testing. */
  readonly systemPrompt: string;
  /** User prompt sent to the LLM. Stored for the same reasons. */
  readonly userPrompt: string;
}

export interface MarkCompletedArgs {
  readonly aiGenerationId: string;
  readonly generatedText: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly latencyMs: number;
  /**
   * Cost in microcents (BigInt). 1 USD = 100_000_000 microcents.
   * Computed by `estimateCostMicrocents` in @winback/ai using
   * provider + model + actual token counts from the response.
   */
  readonly costMicrocents: bigint;
}

export interface MarkFailedArgs {
  readonly aiGenerationId: string;
  /**
   * Error reason. Truncated to 1000 chars at the repository boundary
   * (DB column is uncapped String?, but unbounded growth is a
   * footgun).
   */
  readonly lastError: string;
}
