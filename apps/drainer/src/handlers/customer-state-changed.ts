/**
 * Handler for the `customer.state_changed` outbox event — Epic F §F-9.
 *
 * Pre-Epic-F this event routed to `handleNoop` (per dispatch.ts comment
 * "until Epic G's winback campaign engine ships"). Epic F batch 4 replaces
 * that noop with the 10-step §F-9 contract:
 *
 *    1.  Parse payload via `customerStateChangedPayloadSchema`.
 *    2.  Gate on newState ∈ {at_risk, dormant, lost}.
 *    3.  Defensive: bail if oldState === newState (producer also gates).
 *    4.  Read Merchant + MerchantSettings + BillingSubscription
 *        (INSIDE `withTenantScope`, OUTSIDE any prisma.$transaction).
 *    4.5 A2 / §2 — per-merchant hourly rate-limit check (Redis-INCR).
 *        If over `hourlyGenerationCap` → `ai.rate_limited` audit + log
 *        + return (NO AiGeneration row created; audit IS the record).
 *        BEFORE the spend-cap check: cheaper denial, independent failure
 *        mode (burst-starvation vs budget overrun). See in-line STEP
 *        4.5 docstring for the §2 gate-point resolution.
 *    5.  Pre-flight spend-ceiling check. If exceeded → audit row +
 *        log + return (NO AiGeneration row created — audit IS the
 *        forensic record).
 *    6a. Read Customer for prompt context (firstName/lastName).
 *    6b. Fetch recent orders via Shopify Admin GraphQL (OUTSIDE tx —
 *        locked rule: no external HTTP inside Postgres tx).
 *    6c. ◆ Active price rules — DELIBERATELY OMITTED ◆
 *        See in-line docstring below for the V9-supersession rationale.
 *    7.  Build prompt via pure `buildWinbackPrompt(...)`.
 *    8.  Atomic 2-write tx: createPending(AiGeneration) +
 *        createDraft(Message) per §F-Q7 lock.
 *    9.  Enqueue `ai.generate` BullMQ job with jobId = aiGenerationId
 *        (§F-8 idempotent-replay contract: Worker no-ops when status
 *        !== 'pending').
 *    10. Return. Handler does NOT wait for LLM response.
 *
 * The AI Worker (Step 2c) consumes the queued job, calls the active
 * provider via `selectActiveProvider`, and performs the 3-write atomic
 * completion tx (markCompleted + updateGeneratedText + incrementSpend).
 */

import type { Prisma } from '@prisma/client';
import {
  type WinbackTriggerState,
  buildWinbackPrompt,
  estimateCostMicrocents,
  getAiConfig,
} from '@winback/ai';
import { AUDIT_ACTIONS, parseAiTone } from '@winback/contracts';
import {
  AiGenerationRepository,
  AiSpendBucketRepository,
  AuditLogRepository,
  type CustomerStateValue,
  MessageRepository,
  type OutboxEventRow,
  customerStateChangedPayloadSchema,
  withTenantScope,
} from '@winback/db';
import { getLogger } from '@winback/logger';
import { incrementAndCheck } from '@winback/queue';
import {
  type RecentOrderProduct,
  buildAdminClient,
  fetchRecentOrders,
} from '@winback/shopify';

import type { DrainerContext } from '../context.js';

const log = getLogger('drainer.handler.customer-state-changed');

/**
 * Type predicate narrowing `CustomerStateValue` to `WinbackTriggerState`.
 *
 * Replaces an `as WinbackTriggerState` cast — TypeScript can prove
 * narrowing through the predicate, so the gate that filters non-winback
 * states ALSO narrows the type. Both `AiGenerationRepository.createPending`
 * (accepts the narrowed value as `triggerState: string` — `WinbackTriggerState`
 * is assignable) and `buildWinbackPrompt` (requires `WinbackTriggerState`
 * exactly) consume the narrowed value cast-free.
 */
function isWinbackTriggerState(s: CustomerStateValue): s is WinbackTriggerState {
  return s === 'at_risk' || s === 'dormant' || s === 'lost';
}

/**
 * Worst-case estimated INPUT tokens for the pre-flight spend-ceiling
 * calculation. Used with `AI_MAX_TOKENS` (worst-case output) so the
 * ceiling check rejects calls that COULD exceed the cap, not just calls
 * that DEFINITELY would.
 *
 * Conservative upper bound — the typical winback system + user prompt
 * runs ~200-400 tokens. 500 leaves headroom for long brandVoiceSample +
 * customInstructions in `MerchantSettings.aiTone`. For DeepSeek-v4-flash
 * the input contribution at 500 tokens × 14 microcents/1M = 0.007
 * microcents (negligible); Claude Opus inputs are ~50× pricier but still
 * sub-microcent. The output side dominates.
 */
const ESTIMATED_INPUT_TOKENS_FOR_CEILING_CHECK = 500;

const WINBACK_TRIGGER_STATES_LABEL = ['at_risk', 'dormant', 'lost'] as const;

export async function handleCustomerStateChanged(
  ctx: DrainerContext,
  row: OutboxEventRow,
): Promise<void> {
  // STEP 1 — Parse the producer-shaped payload. Throws ZodError on
  // malformed input (producer drift); drainer's per-row try/catch
  // markFails the OutboxEvent for operator triage.
  const payload = customerStateChangedPayloadSchema.parse(row.payload);

  // STEP 2 — newState gate. Non-winback transitions are noops.
  if (!isWinbackTriggerState(payload.newState)) {
    log.debug(
      {
        eventId: row.id,
        merchantId: payload.merchantId,
        newState: payload.newState,
        winbackStates: WINBACK_TRIGGER_STATES_LABEL,
      },
      'state_changed: newState not a winback trigger; skipping',
    );
    return;
  }

  // STEP 3 — Defensive same-state gate. The Epic E session 2 scoring
  // producer already filters on `stateChanged === true`; this is belt-
  // and-suspenders against future producer-side regression.
  if (payload.oldState === payload.newState) {
    log.warn(
      { eventId: row.id, merchantId: payload.merchantId, state: payload.newState },
      'state_changed: old === new (defensive bail); skipping',
    );
    return;
  }

  // payload.newState is now narrowed to WinbackTriggerState via the
  // type-guard. Use the narrowed value everywhere downstream.
  const triggerState: WinbackTriggerState = payload.newState;

  await withTenantScope(payload.merchantId, async () => {
    // STEP 4 — BillingSubscription gate. Read OUTSIDE any tx.
    const billing = await ctx.prisma.billingSubscription.findUnique({
      where: { merchantId: payload.merchantId },
      select: { status: true },
    });
    if (
      billing === null ||
      (billing.status !== 'active' && billing.status !== 'trialing')
    ) {
      log.info(
        {
          eventId: row.id,
          merchantId: payload.merchantId,
          billingStatus: billing?.status ?? null,
        },
        'state_changed: billing not active/trialing; skipping',
      );
      return;
    }

    // STEP 4 (continued) — Merchant + MerchantSettings reads (also
    // outside any tx; the prompt builder needs name/currency/aiTone).
    // `installedAt` + `shopDetailsFetchedAt` are selected for the
    // un-enriched-currency WARN log below (operator visibility only —
    // not consumed by the prompt builder).
    const merchant = await ctx.prisma.merchant.findUnique({
      where: { id: payload.merchantId },
      select: {
        name: true,
        currency: true,
        shop: true,
        installedAt: true,
        shopDetailsFetchedAt: true,
      },
    });
    if (merchant === null) {
      log.warn(
        { eventId: row.id, merchantId: payload.merchantId },
        'state_changed: merchant row not found (rare cascade race?); skipping',
      );
      return;
    }

    const settings = await ctx.prisma.merchantSettings.findUnique({
      where: { merchantId: payload.merchantId },
      select: {
        monthlyAiSpendCapCents: true,
        hourlyGenerationCap: true,
        aiTone: true,
        // A4 §4.2 — winback discount policy. `enabled` gates WHETHER (safe-by-
        // default false); `percent` is HOW MUCH, snapshotted onto the row.
        winbackDiscountEnabled: true,
        winbackDiscountPercent: true,
      },
    });
    if (settings === null) {
      log.warn(
        { eventId: row.id, merchantId: payload.merchantId },
        'state_changed: merchant settings missing (defensive — defaults are created at install); skipping',
      );
      return;
    }

    // STEP 4.5 — A2 / POST-EPIC-F §2: per-merchant hourly rate-limit
    // check. Runs BEFORE the spend-cap check at STEP 5 because rate-
    // limiting protects against BURST-STARVATION (a flooding merchant
    // monopolizing the AI Worker), while spend-cap protects against
    // BUDGET overrun — those are independent failure modes and the
    // cheaper Redis-INCR check goes first.
    //
    // GATE-POINT RATIONALE (resolves POST-EPIC-F §2's apparent
    // self-contradiction — implementation note recorded in §2):
    //   §2's literal text says "AI Worker checks rate limit"; its
    //   pattern reference says "model the rate limiter on the spend-
    //   ceiling pattern"; its explicit constraint says "Cheap
    //   rejection before any DB write." The spend-ceiling check lives
    //   HERE (handler, not worker — see §F-9 step 5 + EPIC-F-DESIGN
    //   line 393 "WITHOUT creating an AiGeneration row"), so mirror-
    //   ing the pattern + honoring the "cheap rejection before any
    //   DB write" constraint pins the gate-point to THIS handler,
    //   pre-spend-cap. Putting it in the worker would write 4 rows
    //   per cap-hit (AiGeneration + Message + OutboxEvent + later
    //   failed-status update), defeating the burst-starvation
    //   defence's reason for existing.
    //
    // Cap-hit semantics: NO `AiGeneration` row is created; the
    // `ai.rate_limited` AuditLog IS the forensic record (mirrors
    // `ai.spend_cap_exceeded`). The `lastError` clause in §2's text
    // is moot — there's no row to set it on.
    //
    // FORENSIC NOISE FAILURE MODE: same as spend-cap (a drainer crash
    // between audit append and outbox-mark-processed → next cycle re-
    // runs handler, audit fires again, duplicate `ai.rate_limited`
    // row). Operator dedupes by `context.eventId`.
    //
    // OBSERVABILITY: this audit is LOAD-BEARING. It's the ONLY signal
    // that a merchant is losing winbacks to the cap. `merchantId` is
    // top-level on AuditLog (not just in context), so "which merchants
    // hit their cap this hour" is a clean indexed query.
    const rateLimit = await incrementAndCheck(
      payload.merchantId,
      settings.hourlyGenerationCap,
    );
    if (!rateLimit.allowed) {
      const auditLogRepo = new AuditLogRepository(ctx.prisma);
      await auditLogRepo.append({
        merchantId: payload.merchantId,
        shop: merchant.shop,
        actorType: 'system',
        actorId: 'drainer',
        action: AUDIT_ACTIONS.ai.rate_limited,
        targetType: 'customer',
        targetId: payload.customerId,
        context: {
          currentCount: rateLimit.currentCount,
          hourlyGenerationCap: settings.hourlyGenerationCap,
          hourBucket: Math.floor(Date.now() / 3_600_000),
          eventId: row.id,
        },
      });
      log.info(
        {
          eventId: row.id,
          merchantId: payload.merchantId,
          customerId: payload.customerId,
          currentCount: rateLimit.currentCount,
          hourlyGenerationCap: settings.hourlyGenerationCap,
        },
        'state_changed: hourly generation cap exceeded; generation denied (audit row written)',
      );
      return;
    }

    // STEP 5 — Pre-flight spend ceiling check. BEFORE any DB write
    // per §F-9 step 5: cheap denial. The cap is in CENTS but
    // `sumMonthSpend` returns MICROCENTS, so convert with × 100_000n.
    //
    // Worst-case output is bounded by AI_MAX_TOKENS (the same value
    // we pass to the provider as maxTokens). Worst-case input is the
    // conservative ESTIMATED_INPUT_TOKENS_FOR_CEILING_CHECK constant
    // — see its docstring above.
    const aiConfig = getAiConfig();
    const spendBucketRepo = new AiSpendBucketRepository(ctx.prisma);
    const currentSpendMicrocents = await spendBucketRepo.sumMonthSpend({
      merchantId: payload.merchantId,
      asOf: new Date(),
    });
    const estimatedCallMicrocents = estimateCostMicrocents(
      aiConfig.AI_PROVIDER,
      aiConfig.AI_MODEL,
      ESTIMATED_INPUT_TOKENS_FOR_CEILING_CHECK,
      aiConfig.AI_MAX_TOKENS,
    );
    const capMicrocents = settings.monthlyAiSpendCapCents * 100_000n;
    if (currentSpendMicrocents + estimatedCallMicrocents > capMicrocents) {
      // Spend ceiling exceeded — audit row IS the forensic record (NO
      // AiGeneration row created on denial). The audit append uses the
      // active tenant scope (set by withTenantScope above) — the Prisma
      // extension's hooks.ts reads AsyncLocalStorage via `getTenantScope()`
      // at line 81, so `ctx.prisma` writes inside this block are tenant-
      // asserted automatically.
      //
      // FORENSIC NOISE FAILURE MODE (rare, NOT a correctness bug):
      // If the drainer crashes between the audit append and the
      // outbox-mark-processed step in the parent drain loop, the audit
      // row exists but the OutboxEvent.processedAt is still null. The
      // next drainer cycle re-runs this handler, the spend check fires
      // again, and a SECOND audit row is written. Forensic noise — a
      // duplicate `ai.spend_cap_exceeded` row for the same event-id.
      // Operator can grep by `context.eventId` to dedupe at query time.
      // M10 hardening could fold the audit write into the drainer's
      // outer drain-tx for atomic outbox-process-with-audit; v1 ships
      // with the noise risk.
      const auditLogRepo = new AuditLogRepository(ctx.prisma);
      await auditLogRepo.append({
        merchantId: payload.merchantId,
        shop: merchant.shop,
        actorType: 'system',
        actorId: 'drainer',
        action: AUDIT_ACTIONS.ai.spend_cap_exceeded,
        targetType: 'customer',
        targetId: payload.customerId,
        context: {
          currentSpendMicrocents: currentSpendMicrocents.toString(),
          capMicrocents: capMicrocents.toString(),
          estimatedCallMicrocents: estimatedCallMicrocents.toString(),
          monthlyAiSpendCapCents: settings.monthlyAiSpendCapCents.toString(),
          eventId: row.id,
        },
      });
      log.info(
        {
          eventId: row.id,
          merchantId: payload.merchantId,
          customerId: payload.customerId,
          currentSpendMicrocents: currentSpendMicrocents.toString(),
          capMicrocents: capMicrocents.toString(),
          estimatedCallMicrocents: estimatedCallMicrocents.toString(),
        },
        'state_changed: spend cap exceeded; generation denied (audit row written)',
      );
      return;
    }

    // STEP 6a — Customer read for prompt context.
    const customer = await ctx.prisma.customer.findUnique({
      where: { id: payload.customerId },
      select: { firstName: true, lastName: true },
    });
    if (customer === null) {
      log.warn(
        {
          eventId: row.id,
          merchantId: payload.merchantId,
          customerId: payload.customerId,
        },
        'state_changed: customer row not found (cascade race — customer redacted between scoring + handler); skipping',
      );
      return;
    }

    // STEP 6b — Shopify recent-orders read. EXTERNAL HTTP — MUST run
    // OUTSIDE prisma.$transaction (locked rule: no external HTTP inside
    // a Postgres tx). Handler swallows + falls back to [] on failure so
    // Shopify outage doesn't block winback message generation.
    let recentProducts: readonly RecentOrderProduct[] = [];
    try {
      const adminClient = buildAdminClient(ctx.prisma, ctx.shopifyConfig);
      recentProducts = await fetchRecentOrders(adminClient, {
        merchantId: payload.merchantId,
        customerId: payload.shopifyCustomerId,
      });
    } catch (err) {
      log.warn(
        {
          err,
          eventId: row.id,
          merchantId: payload.merchantId,
          customerId: payload.customerId,
        },
        'state_changed: fetchRecentOrders failed; proceeding with empty recentProducts',
      );
    }

    // STEP 6c — Active price rules: DELIBERATELY OMITTED.
    //
    // §F-9 originally specified "Active price rules (Shopify Admin
    // GraphQL — read_price_rules scope)" as step 6c. The §F-9/§F-7
    // design drift was resolved by Lock V9 in Epic F batch 2:
    //
    //   - §F-7's original `WinbackPromptArgs.priceRules` field was
    //     DROPPED from the shipped prompt-builder
    //     (packages/ai/src/prompt-builder.ts:83-95 has no priceRules).
    //
    //   - V9 placeholder tokens ({{DISCOUNT_CODE}} +
    //     {{DISCOUNT_VALUE_PERCENT}}) replaced the "show LLM the real
    //     price rules" approach. The LLM never sees real discount
    //     values — it emits placeholders that a deterministic post-
    //     processor substitutes at send time.
    //
    //   - With Q-D3 (discount: null for v1), no discount/price-rule
    //     path runs through buildWinbackPrompt at all.
    //
    //   - Section 4 batch 4.2 (post-Epic-F, per
    //     POST-EPIC-F-CONSCIOUS-DECISION.md) owns Shopify discount
    //     CREATION (different API surface: discountCodeBasicCreate
    //     mutation, not price-rule reads). When that work ships, the
    //     discount flows in via the V9 placeholder tokens.

    // STEP 7 — Build prompt. Pure function; no I/O.
    //
    // `parseAiTone` re-validates the stored JSON shape against the
    // canonical `aiToneSchema` — throws ZodError on malformed data
    // (e.g. legacy row predating the write-time validator, direct
    // psql edit). Drainer's per-row try/catch markFails the event;
    // M10 candidate is a softer fallback to `null` here.
    //
    // Currency null fallback: `Merchant.currency` is `String?` in
    // the schema. Defaults to 'USD' for the AI prompt — currency is
    // display-only ("USD 199.95"), not used for monetary math.
    //
    // The Q-H1 follow-up referenced in the original comment IS
    // implemented: enrichment fetches `shop.currencyCode` via Shopify
    // Admin API and writes it to `Merchant.currency` via two
    // mechanisms (Q-H1 closure, this commit):
    //
    //   1. D2 — `handleMerchantInstalled` (apps/drainer/src/handlers/
    //      merchant.ts) calls `enrichInstall` immediately after the
    //      `merchant.installed` outbox event lands. Runs out-of-tx
    //      (MARK_BEFORE_INVOKE), so within seconds of OAuth callback.
    //   2. D3 — `runEnrichmentSweep` (apps/scheduler/src/handlers/
    //      enrichment-sweep.ts) — every 15 min, retries enrichment
    //      for merchants with `shopDetailsFetchedAt IS NULL AND
    //      installedAt < NOW() - INTERVAL '10 minutes'`. Self-heals
    //      D2 failures.
    //
    // The 'USD' fallback fires ONLY when this handler runs against a
    // merchant whose enrichment hasn't completed yet — typically a
    // narrow window (seconds for happy-path; up to 10 minutes for
    // D2-failed installs before D3 catches up). Beyond 10 minutes,
    // the WARN log below means D3 is failing repeatedly + needs
    // operator attention. M10 follow-up (POINTS-TO-CONSIDER) tracks
    // the conditional hard-block: if these WARN logs surface
    // regularly post-launch, replace the fallback with a skip.
    const aiTone = parseAiTone(settings.aiTone);
    if (merchant.currency === null) {
      log.warn(
        {
          eventId: row.id,
          merchantId: payload.merchantId,
          shop: merchant.shop,
          installedAt: merchant.installedAt.toISOString(),
          shopDetailsFetchedAt:
            merchant.shopDetailsFetchedAt?.toISOString() ?? null,
          eventTrigger: 'customer.state_changed',
          timeSinceInstallMs:
            Date.now() - merchant.installedAt.getTime(),
        },
        'state_changed: merchant currency not enriched; falling back to USD for AI prompt — D3 enrichment-sweep will heal on next tick (>10min installs warrant operator check)',
      );
    }
    const promptCurrency = merchant.currency ?? 'USD';

    // A4 §4.2 — discount INTENT decision (Option B; safe-by-default off).
    // `winbackDiscountEnabled` (merchant opt-in) gates whether this winback
    // offers a discount. When on, we snapshot `winbackDiscountPercent` NOW so
    // a later settings change never rewrites a message that already shipped,
    // and pass a non-null `discount` to flip the V9 token block on. The real
    // code does not exist yet — the AI Worker mints it AFTER the LLM call and
    // substitutes it into the response. The snapshot is persisted on the
    // AiGeneration row (`discountValuePercent`) and ALSO doubles as the
    // worker's intent flag to mint.
    const discountValuePercent = settings.winbackDiscountEnabled
      ? settings.winbackDiscountPercent
      : null;

    const prompt = buildWinbackPrompt({
      customer: {
        firstName: customer.firstName,
        lastName: customer.lastName,
        rDays: payload.rfmScore.rDays,
        fCount: payload.rfmScore.fCount,
        // Rule #19 boundary: payload carries mCents as a string of
        // decimal digits (BigInt JSON-safe shape). Coerce at the
        // boundary into the bigint the rest of the pipeline expects.
        mCents: BigInt(payload.rfmScore.mCents),
        currency: promptCurrency,
        triggerState,
        previousState: payload.oldState,
      },
      merchant: {
        name: merchant.name,
        shopCurrency: promptCurrency,
        aiTone,
      },
      recentProducts,
      // V9 — INTENT FLAG only. Non-null ⇒ emit the placeholder tokens; the
      // real values are substituted by the worker post-generation (A4 §4.2).
      discount: discountValuePercent === null ? null : { valuePercent: discountValuePercent },
    });

    // STEP 8 — Atomic 2-write tx: AiGeneration (status=pending) +
    // Message (status=draft). §F-Q7 atomicity lock — every Message
    // ALWAYS has a parent AiGeneration created in the SAME tx.
    const { aiGenerationId } = await ctx.prisma.$transaction(async (extendedTx) => {
      // Prisma 5 typing gap — same cast pattern as customer.ts,
      // order.ts, install.ts. Runtime extension hooks fire on
      // `extendedTx`; only TS typing differs.
      const tx = extendedTx as unknown as Prisma.TransactionClient;

      const aiGenRepo = new AiGenerationRepository(ctx.prisma);
      const createResult = await aiGenRepo.createPending(
        {
          merchantId: payload.merchantId,
          customerId: payload.customerId,
          triggerState,
          previousState: payload.oldState,
          rDays: payload.rfmScore.rDays,
          fCount: payload.rfmScore.fCount,
          mCents: BigInt(payload.rfmScore.mCents),
          currency: promptCurrency,
          // Epic E session 2's scoring producer emits no churn-risk
          // score in the v1 payload. Null per AiGenerationRepository
          // contract (`churnRiskScore: number | null`).
          churnRiskScore: null,
          provider: aiConfig.AI_PROVIDER,
          modelId: aiConfig.AI_MODEL,
          systemPrompt: prompt.systemPrompt,
          userPrompt: prompt.userPrompt,
          // A4 §4.2 — snapshot the discount intent + value onto the row.
          // Non-null tells the worker to mint; null means no discount.
          discountValuePercent,
        },
        tx,
      );

      const messageRepo = new MessageRepository(ctx.prisma);
      await messageRepo.createDraft(
        {
          merchantId: payload.merchantId,
          customerId: payload.customerId,
          aiGenerationId: createResult.aiGenerationId,
        },
        tx,
      );

      return { aiGenerationId: createResult.aiGenerationId };
    });

    // STEP 9 — Enqueue ai.generate BullMQ job. jobId = aiGenerationId
    // for idempotent replay per §F-8 line 368: Worker reads the
    // AiGeneration row on pickup; if status !== 'pending', no-ops
    // (stalled-job re-pickup, manual replay, etc.).
    //
    // attempts: 3 with exponential backoff (delay: 1000 ms base) per
    // §F-8 line 373 "Provider 429 / 503 → BullMQ delay-retry with
    // exponential backoff, up to 3 attempts." Worker classifies
    // non-retryable errors (content filter, auth, invalid request)
    // and uses BullMQ's `discardLater()`-equivalent to skip retries
    // for those — that classification logic lives in Step 2c.
    await ctx.queues.aiGenerate.add(
      'generate',
      {
        aiGenerationId,
        merchantId: payload.merchantId,
        customerId: payload.customerId,
      },
      {
        jobId: aiGenerationId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      },
    );

    // STEP 10 — Done. Handler does NOT wait for the LLM response.
    log.info(
      {
        eventId: row.id,
        merchantId: payload.merchantId,
        customerId: payload.customerId,
        aiGenerationId,
        triggerState,
        previousState: payload.oldState,
        recentProductsCount: recentProducts.length,
        provider: aiConfig.AI_PROVIDER,
        model: aiConfig.AI_MODEL,
      },
      'state_changed: AiGeneration created + ai.generate job enqueued',
    );
  });
}
