import type { Prisma } from '@prisma/client';

import type { WinbackPrisma } from '../client.js';

/**
 * Repository for the `Message` table — Epic F batch 1's minimal write
 * chokepoint. Epic G's batch 1 extends with status-transition methods
 * (e.g. `markSent`, `markFailed`, `markSuppressed`) once the
 * `MessageStatus` enum is extended via `ALTER TYPE ADD VALUE`.
 *
 * Two methods for the batch-3 surface:
 *
 *   - `createDraft`         — sibling call to `AiGenerationRepository.
 *                              createPending` inside the drainer's
 *                              `handleCustomerStateChanged` tx (§F-9
 *                              step 8b). Writes `status='draft'` with
 *                              empty `generatedText`; AI Worker fills
 *                              `generatedText` later via
 *                              `updateGeneratedText`. §F-Q7 atomicity:
 *                              every Message ALWAYS has an
 *                              AiGeneration parent created in the SAME
 *                              tx, never half-written.
 *
 *   - `updateGeneratedText` — AI Worker writes the denormalised
 *                              generated text into the Message row
 *                              after the LLM call completes. Keyed by
 *                              `aiGenerationId` (NOT `messageId`)
 *                              because the worker holds the
 *                              AiGeneration row reference, not the
 *                              Message row reference. `Message.
 *                              aiGenerationId` is a GLOBAL `@unique`
 *                              (cuid is globally unique; single-column
 *                              unique is sufficient — see schema lines
 *                              1091-1093). `updateMany` is the
 *                              safe path: defensive against extension
 *                              quirks on update + uniqueWhere
 *                              composition, idempotent on replay.
 *
 * Scope semantics. `Message` is in `TENANT_SCOPED_MODELS` — the Prisma
 * extension auto-injects + asserts `merchantId` on every read and
 * write. Repository methods don't repeat that work. Neither method
 * carries a documented system-scope contract, so no `getTenantScope`
 * guard at method top is needed (per the M-1/C-5 enforcement
 * pattern).
 *
 * Transaction handling. Both methods take optional `tx`. The Epic F
 * batch 4 drainer handler will pass the same `tx` to AiGenerationRepo
 * .createPending + MessageRepo.createDraft so both rows commit
 * atomically per §F-Q7; the AI Worker similarly passes one `tx` to
 * AiGenerationRepo.markCompleted + MessageRepo.updateGeneratedText +
 * AiSpendBucketRepo.incrementSpend at completion time.
 *
 * Why no `findByAiGenerationId` method. Considered + dropped during
 * Phase 1 design. The AI Worker (batch 4) holds the `AiGeneration`
 * row reference in hand; it doesn't need to look up the Message row
 * before updating because `updateGeneratedText` keys directly by
 * `aiGenerationId` via the global `@unique`. Adding a find method
 * would create a caller-pattern footgun (read-then-update races vs.
 * direct updateMany).
 */
export class MessageRepository {
  constructor(private readonly prisma: WinbackPrisma) {}

  /**
   * Writes a draft Message row inside the same tx as the matching
   * AiGeneration's `createPending`. The row carries `aiGenerationId`
   * already (FK populated at create time, satisfies §F-Q7
   * atomicity — never an Message without its AiGeneration).
   *
   * `generatedText` is initialised empty. The AI Worker fills it via
   * `updateGeneratedText` after the LLM responds. Epic G's dispatch
   * worker reading `WHERE status = 'draft'` can additionally filter
   * on `generatedText != ''` to skip pre-completion drafts.
   */
  async createDraft(
    args: CreateDraftArgs,
    tx?: Prisma.TransactionClient,
  ): Promise<{ messageId: string }> {
    const client = tx ?? this.prisma;
    const row = await client.message.create({
      data: {
        merchantId: args.merchantId,
        customerId: args.customerId,
        aiGenerationId: args.aiGenerationId,
        generatedText: '',
        // status defaults to 'draft' per schema.
      },
      select: { id: true },
    });
    return { messageId: row.id };
  }

  /**
   * Updates the Message row's `generatedText` after the LLM response
   * comes back. Keyed by `aiGenerationId` (the global `@unique`).
   *
   * Idempotency. Repeating the call with the same text is a no-op
   * write. The AI Worker may replay (BullMQ stalled-job re-pickup);
   * the second call rewrites the same value. `updateMany` returns
   * `updatedCount: 1` on the first call and `updatedCount: 1` again
   * on the second — both correctly match exactly one row keyed on
   * the unique. We do NOT add a status filter here (unlike
   * `AiGenerationRepository.markCompleted/markFailed` which DO need
   * the `status='pending'` filter to make atomic state transitions
   * idempotent). Reason: a Message row's `generatedText` is the
   * denormalised echo of `AiGeneration.generatedText`; double-writing
   * the same value doesn't violate any invariant.
   *
   * Note on no Message.update: we use `updateMany` rather than
   * `update` even though `aiGenerationId` is `@unique`. Two reasons:
   *   1. Defensive against any future extension hook that injects
   *      merchantId into the `update` where clause — Prisma's
   *      `update` requires the where clause to match a unique
   *      constraint, and a composite key with extension-injected
   *      merchantId is NOT a known unique here (the schema's only
   *      unique on Message is `aiGenerationId` alone).
   *   2. Returning `updatedCount` lets the caller assert "exactly
   *      one row touched" which is a stronger invariant than
   *      `update`'s "find or throw" semantics.
   */
  async updateGeneratedText(
    args: UpdateGeneratedTextArgs,
    tx?: Prisma.TransactionClient,
  ): Promise<{ updatedCount: number }> {
    const client = tx ?? this.prisma;
    const result = await client.message.updateMany({
      where: { aiGenerationId: args.aiGenerationId },
      data: { generatedText: args.generatedText },
    });
    return { updatedCount: result.count };
  }
}

// ---------------------------------------------------------------------------
// Public argument types
// ---------------------------------------------------------------------------

export interface CreateDraftArgs {
  readonly merchantId: string;
  /** Customer cuid PK. */
  readonly customerId: string;
  /**
   * AiGeneration cuid PK. Caller MUST have already created the
   * AiGeneration row in the same tx (or earlier — but typically
   * same tx per §F-Q7 atomicity).
   */
  readonly aiGenerationId: string;
}

export interface UpdateGeneratedTextArgs {
  readonly aiGenerationId: string;
  /**
   * The LLM-generated text, denormalised from
   * `AiGeneration.generatedText` for fast read at send time. Epic G's
   * dispatch worker reads this without joining back to AiGeneration.
   */
  readonly generatedText: string;
}
