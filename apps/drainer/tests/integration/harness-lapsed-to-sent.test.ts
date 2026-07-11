/**
 * Integration test for the FULL lapsed→sent pipeline — Phase 3 (the capstone,
 * LEG 3 OF 3) of the phased harness build.
 *
 * Chains onto Phase 2 (`harness-lapsed-to-generation.test.ts`, merged
 * `f228857`): it re-runs the SAME real scoring→drain→handler→worker chain
 * to PRODUCE a draft `Message` with real `generatedText`, then carries THAT
 * produced draft the rest of the way through the real dispatch path to
 * `sent` — against real Postgres, with a mocked SES adapter:
 *
 *   real decay sweep (scheduler runDecaySweep)          ┐
 *     → OutboxEvent (real producer payload)             │
 *   → real runDrainTick → real dispatchEvent            │  PHASE 2's proven
 *     → real handleCustomerStateChanged                 │  chain — reused
 *       → 2-write tx (AiGeneration(pending)+Message(draft))
 *   → real processAiGenerateJob (mocked LLM provider)   │
 *     → Message.generatedText populated                 ┘
 *   ─────────────────────────────────────────────────── NEW in Phase 3:
 *   → real runDispatchSweep (scheduler)
 *     → real findDispatchableDrafts PICKUP (the real generated draft)
 *     → enqueue campaign.dispatch job to STUB queue
 *   → real processCampaignDispatchJob (drainer dispatch worker)
 *     → claimTarget → replay guard → real 6-GATE CHAIN (all pass)
 *     → startSending → mocked emailProvider.send() → markSentWithQuota
 *       → CampaignTarget + Message → 'sent', quota bucket++, dispatch.sent audit
 *
 * WHY THIS SEAM EXISTS (what has NEVER been chained from a real Message).
 *
 * The 8.4 dispatch suite (`dispatch-send.test.ts`) HAND-SEEDS the entire
 * dispatchable state in its beforeEach — it creates the Message with
 * `generatedText` already filled AND hand-creates the CampaignTarget at
 * `status='pending'`, SKIPPING the pickup query and the claim. So the two
 * NEW things this capstone proves:
 *   1. `findDispatchableDrafts`'s eligibility query
 *      (`campaign.repository.ts:155`) selecting a draft whose `generatedText`
 *      was written by the REAL AI worker (never a hand-filled blob before).
 *   2. The 6-gate chain (`gate-chain.ts`) running against real
 *      phase-2-produced rows (real consent, real AiGeneration.createdAt for
 *      freshness, real generatedText for the send body).
 * After this test, the lapsed→sent claim is proven end-to-end: a seeded
 * lapsed customer, scored → generated → dispatched → gated → SENT.
 *
 * CLOCK PIN — MANDATORY FOR CORRECTNESS HERE (not just seed-consistency).
 * Unlike Phase 2 (no time-of-day gate in the generation path), Phase 3's
 * gate 5 (quiet-hours, `gate-chain.ts:100-115`) reads the dispatch worker's
 * `new Date()` (`dispatch.worker.ts:168`) and compares merchant-local hour
 * vs `sendTimeStartHour=9 / sendTimeEndHour=18` (defaults; test merchant has
 * no timezone → UTC fallback). Pinning to today@noon UTC (12:00) lands
 * inside [9,18) so gate 5 PASSES deterministically at any wall-clock. This
 * is the handoff carry-forward checklist item (PR #123) firing exactly as
 * intended: an integration test reading a time-of-day gate MUST pin the
 * clock. `toFake: ['Date']`-only is load-bearing — the dispatch worker's
 * in-pass completion-tx retry uses a real `sleep(100ms)`
 * (`dispatch.worker.ts:418`); faking setTimeout would stall it.
 *
 * The `status==='sent'` assertion is SELF-WITNESSING for the pin: if the
 * pin failed and the wall-clock were outside 9-18 UTC, gate 5 would defer
 * the target and the final Message would stay `draft`, not reach `sent`.
 * So a green test at ANY UTC hour is itself proof the pin held.
 *
 * CROSS-PACKAGE IMPORT (third-of-kind — Phases 1+2 established it). This
 * file imports `runDecaySweep` + `runDispatchSweep` from
 * `apps/scheduler/src/handlers/` via relative path. Same posture: no
 * package.json edit, no tsconfig ref, no runtime cycle; vitest resolves
 * source; the `globalThis.__winbackScopeStore` ALS (`tenant-scope.ts:139`)
 * makes src/dist transparent.
 *
 * SEED+CHAIN DUPLICATION (deliberate — founder ruling). Phase 2's seed +
 * scoring→generation chain is duplicated here rather than extracted to a
 * shared helper. Re-opening the merged, proven-green Phase 2 file for a
 * tidiness refactor risks more than ~70 duplicated lines saves. If the
 * duplication ever warrants extraction, that is its own deliberate change
 * with its own verification — never a side effect of this capstone build.
 *
 * Gate delta: `drainer:test` 64 → 65 (+1, capstone happy path only). The
 * dispatch-side negatives (suppressed-customer, etc.) are NOT added as
 * standing tests — the consent-flip mutation check (run pre-commit)
 * exercises the gate-chain-runs path transiently; a standing test would
 * only pin an already-pinned property.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — MUST hoist above the static imports below.
// ---------------------------------------------------------------------------

vi.mock('@winback/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@winback/ai')>();
  return { ...actual, selectActiveProvider: vi.fn() };
});

vi.mock('@winback/shopify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@winback/shopify')>();
  return {
    ...actual,
    buildAdminClient: vi.fn(() => ({})),
  };
});

// ---------------------------------------------------------------------------
// Imports — AFTER mocks
// ---------------------------------------------------------------------------

import {
  type AiGenerateArgs,
  type AiGenerateResult,
  selectActiveProvider,
} from '@winback/ai';
import {
  AUDIT_ACTIONS,
  type CampaignDispatchJobPayload,
  OUTBOX_EVENTS,
} from '@winback/contracts';
import { withSystemScope } from '@winback/db';
import {
  assertRead,
  createTestMerchant,
  getTestClient,
  resetDb,
} from '@winback/db/test-utils';
import type {
  EmailSendAccepted,
  EmailSendArgs,
} from '@winback/email';
import type { Job } from 'bullmq';

import type { SchedulerContext } from '../../../scheduler/src/context.js';
import { runDecaySweep } from '../../../scheduler/src/handlers/decay-sweep.js';
import { runDispatchSweep } from '../../../scheduler/src/handlers/dispatch-sweep.js';

import type { DrainerContext } from '../../src/context.js';
import { runDrainTick } from '../../src/drainer.js';
import {
  type AiGenerateJobPayload,
  processAiGenerateJob,
} from '../../src/workers/ai-generate.worker.js';
import { processCampaignDispatchJob } from '../../src/workers/dispatch.worker.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHOP = 'harness-lapsed-to-sent.myshopify.com';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Target lands at `at_risk` (91-180d band); Phase 1's safest lapsed band. */
const TARGET_R_DAYS = 120;
/** Fillers stay `active` — cohort-threshold lift only (INSUFFICIENT_COHORT_THRESHOLD=5). */
const FILLER_R_DAYS = 5;

/** Deterministic LLM mock — assertion checks generatedText verbatim end-to-end. */
const MOCK_GENERATED_TEXT = 'test-generated-body';
const MOCK_INPUT_TOKENS = 100;
const MOCK_OUTPUT_TOKENS = 50;
const MOCK_TOTAL_TOKENS = MOCK_INPUT_TOKENS + MOCK_OUTPUT_TOKENS;

/** Deterministic SES mock return — asserted verbatim on Message.providerMessageId. */
const MOCK_PROVIDER_MESSAGE_ID = 'mock-ses-phase3-0001';
const FROM_ADDRESS = 'winback@example.com';
const CONFIG_SET = 'winback-events';

// ---------------------------------------------------------------------------
// Clock helper — today@noon UTC (near-real-now pin per the PR #123 lesson)
// ---------------------------------------------------------------------------

function noonUtcToday(): Date {
  const nowReal = new Date();
  return new Date(Date.UTC(
    nowReal.getUTCFullYear(),
    nowReal.getUTCMonth(),
    nowReal.getUTCDate(),
    12, 0, 0, 0,
  ));
}

// ---------------------------------------------------------------------------
// Shared harness state
// ---------------------------------------------------------------------------

const prisma = getTestClient();

let merchantId: string;
let targetCustomerId: string;
let fillerCustomerIds: string[];
let campaignId: string;

/** Stub for the handler's `ctx.queues.aiGenerate.add` (Phase 2 chain). */
let aiGenerateAdd: ReturnType<typeof vi.fn>;
/** Stub for the dispatch sweep's `ctx.queues.campaignDispatch.addBulk` (Phase 3). */
let dispatchAddBulk: ReturnType<typeof vi.fn>;
/** Mocked LLM provider generate fn. */
let mockGenerate: ReturnType<typeof vi.fn>;
/** Mocked SES send fn — the dispatch worker's `ctx.emailProvider.send`. */
let mockSesSend: ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Seed helpers — ALL writes through withSystemScope (8.4 Lesson 2)
// ---------------------------------------------------------------------------

async function seedCustomer(shopifyCustomerId: string, firstName: string): Promise<string> {
  return withSystemScope('test.seed_customer', async () => {
    const c = await prisma.customer.create({
      data: {
        merchantId,
        shopifyCustomerId,
        email: `${firstName.toLowerCase()}@example.com`,
        firstName,
        lastName: 'Smith',
        // Consent gate (gate 2) passes ONLY on 'subscribed'.
        emailMarketingConsentState: 'subscribed',
        // Sweep working-set filter is state IN (active,warm,at_risk,dormant).
        state: 'active',
      },
      select: { id: true },
    });
    return c.id;
  });
}

async function seedPaidOrder(args: {
  customerId: string;
  shopifyOrderId: string;
  placedAt: Date;
}): Promise<void> {
  await withSystemScope('test.seed_order', async () => {
    await prisma.order.create({
      data: {
        merchantId,
        customerId: args.customerId,
        shopifyOrderId: args.shopifyOrderId,
        currency: 'USD',
        totalAmountCents: 1000n,
        subtotalAmountCents: 1000n,
        financialStatus: 'paid',
        isTest: false,
        placedAt: args.placedAt,
        shopifyProcessedAt: null,
      },
    });
  });
}

/**
 * The ONE seed addition vs Phase 2: an active email Campaign whose
 * `triggerStates` contains the target's band (`at_risk`). Without it,
 * `findDispatchableDrafts` has no campaign to pair the draft with and the
 * dispatch sweep picks up nothing. Campaign ∈ TENANT_SCOPED_MODELS → the
 * write goes through withSystemScope (8.4 Lesson 2).
 */
async function seedActiveEmailCampaign(): Promise<void> {
  campaignId = await withSystemScope('test.seed_campaign', async () => {
    const c = await prisma.campaign.create({
      data: {
        merchantId,
        name: 'At-risk winback',
        status: 'active',
        channel: 'email',
        triggerStates: ['at_risk'],
      },
      select: { id: true },
    });
    return c.id;
  });
}

/** 1 target (rDays=120 → at_risk) + 5 fillers (rDays=5 → active). */
async function seedCohort(): Promise<void> {
  targetCustomerId = await seedCustomer('gid://shopify/Customer/target', 'Alice');
  await seedPaidOrder({
    customerId: targetCustomerId,
    shopifyOrderId: 'gid://shopify/Order/target',
    placedAt: new Date(noonUtcToday().getTime() - TARGET_R_DAYS * DAY_MS),
  });

  fillerCustomerIds = [];
  for (let i = 1; i <= 5; i++) {
    const id = await seedCustomer(`gid://shopify/Customer/filler-${String(i)}`, `Filler${String(i)}`);
    fillerCustomerIds.push(id);
    await seedPaidOrder({
      customerId: id,
      shopifyOrderId: `gid://shopify/Order/filler-${String(i)}`,
      placedAt: new Date(noonUtcToday().getTime() - FILLER_R_DAYS * DAY_MS),
    });
  }
}

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

function makeSchedulerCtx(): SchedulerContext {
  // runDecaySweep uses only ctx.prisma. runDispatchSweep uses ctx.prisma +
  // ctx.queues.campaignDispatch.addBulk. Both driven off this one context.
  return {
    prisma,
    queues: { campaignDispatch: { addBulk: dispatchAddBulk } as never } as never,
  } as unknown as SchedulerContext;
}

function makeDrainerCtx(): DrainerContext {
  // Drives runDrainTick + handleCustomerStateChanged (ctx.queues.aiGenerate.add),
  // processAiGenerateJob (ctx.prisma + mocked provider), AND
  // processCampaignDispatchJob (ctx.emailProvider + email config).
  return {
    prisma,
    queues: { aiGenerate: { add: aiGenerateAdd } as never } as never,
    emailProvider: { name: 'amazon-ses', send: mockSesSend },
    emailFromAddress: FROM_ADDRESS,
    emailConfigurationSetName: CONFIG_SET,
  } as unknown as DrainerContext;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('LAPSED → SENT full pipeline — real Postgres, real dispatch, mocked LLM + SES (harness Phase 3 of 3)', () => {
  beforeEach(async () => {
    await resetDb();

    // Fake timers BEFORE createTestMerchant + seeds. Date-only faking:
    // setTimeout stays real so the dispatch worker's completion-tx
    // sleep(100ms) retry backoff and the rate-limiter's Redis pipeline
    // do not stall. today@noon UTC lands gate 5 (quiet-hours) in-window.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(noonUtcToday());

    // LLM provider mock (Phase 2 chain).
    vi.mocked(selectActiveProvider).mockReset();
    mockGenerate = vi.fn(async (_args: AiGenerateArgs) => ({
      content: MOCK_GENERATED_TEXT,
      inputTokens: MOCK_INPUT_TOKENS,
      outputTokens: MOCK_OUTPUT_TOKENS,
      totalTokens: MOCK_TOTAL_TOKENS,
      latencyMs: 12,
    } satisfies AiGenerateResult));
    vi.mocked(selectActiveProvider).mockReturnValue({
      name: 'deepseek',
      generate: mockGenerate,
    } as never);

    // SES mock (Phase 3 send). Deterministic providerMessageId asserted
    // verbatim on Message.providerMessageId.
    mockSesSend = vi.fn(async (_args: EmailSendArgs): Promise<EmailSendAccepted> => ({
      providerMessageId: MOCK_PROVIDER_MESSAGE_ID,
      latencyMs: 12,
    }));

    // Stub queues (no real BullMQ — Q-I1(β) posture).
    aiGenerateAdd = vi.fn(async () => ({ id: 'fake-ai-job-id' }));
    dispatchAddBulk = vi.fn(async () => []);

    merchantId = await createTestMerchant(SHOP);
    await seedCohort();
    await seedActiveEmailCampaign();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('seeded lapsed customer → scored → generated → dispatch sweep picks up the real draft → 6 gates pass → mocked SES send → Message + CampaignTarget SENT', async () => {
    const drainerCtx = makeDrainerCtx();
    const schedulerCtx = makeSchedulerCtx();

    // ── PHASE 2 CHAIN (reused) — produce the draft Message ──────────────────

    // (1) Real decay sweep emits the customer.state_changed OutboxEvent.
    await runDecaySweep(schedulerCtx);

    // (2) Real drain → handler creates AiGeneration(pending) + Message(draft),
    // enqueues to the aiGenerate stub.
    const drainResult = await runDrainTick(drainerCtx);
    expect(drainResult.claimed).toBeGreaterThanOrEqual(1);

    // (3) Extract the ai.generate payload + run the real worker (mocked LLM)
    // → fills Message.generatedText.
    expect(aiGenerateAdd).toHaveBeenCalledTimes(1);
    const aiCall = aiGenerateAdd.mock.calls[0];
    const aiPayload = aiCall?.[1] as AiGenerateJobPayload;
    await processAiGenerateJob(drainerCtx, {
      id: aiPayload.aiGenerationId,
      data: aiPayload,
      attemptsMade: 0,
    } as unknown as Job<AiGenerateJobPayload>);

    // Sanity: the draft Message now exists with real generatedText, still
    // `draft`, no CampaignTarget yet (so the dispatch pickup can select it).
    const draftBeforeDispatch = await assertRead(() =>
      prisma.message.findFirst({
        where: { customerId: targetCustomerId, aiGenerationId: aiPayload.aiGenerationId },
      }),
    );
    expect(draftBeforeDispatch).not.toBeNull();
    expect(draftBeforeDispatch?.status).toBe('draft');
    expect(draftBeforeDispatch?.generatedText).toBe(MOCK_GENERATED_TEXT);
    const messageId = draftBeforeDispatch!.id;

    // ── PHASE 3 — dispatch the produced draft to SENT ───────────────────────

    // (4) Real dispatch sweep: findDispatchableDrafts PICKS UP the real
    // generated draft (status=draft + AiGeneration completed + generatedText
    // <> '' + active email campaign band-match + NO CampaignTarget) and
    // enqueues one campaign.dispatch job to the addBulk stub. THE new seam.
    await runDispatchSweep(schedulerCtx);

    expect(dispatchAddBulk).toHaveBeenCalledTimes(1);
    const bulkArg = dispatchAddBulk.mock.calls[0]?.[0] as readonly {
      readonly name: string;
      readonly data: CampaignDispatchJobPayload;
    }[];
    expect(bulkArg).toHaveLength(1);
    const dispatchJob = bulkArg[0];
    expect(dispatchJob?.data.messageId).toBe(messageId);
    expect(dispatchJob?.data.campaignId).toBe(campaignId);
    expect(dispatchJob?.data.customerId).toBe(targetCustomerId);
    expect(dispatchJob?.data.merchantId).toBe(merchantId);

    // (5) Real dispatch worker consumes the job: claim → replay guard →
    // 6-gate chain (all pass) → startSending → mocked SES send →
    // markSentWithQuota completion tx.
    await processCampaignDispatchJob(drainerCtx, {
      id: 'dispatch-job-1',
      data: dispatchJob!.data,
      attemptsMade: 0,
    } as unknown as Job<CampaignDispatchJobPayload>);

    // ── (6) CAPSTONE ASSERTIONS — the full-pipeline proof ───────────────────

    // (6a) Message → sent, provider metadata stamped, generatedText intact.
    const message = await assertRead(() =>
      prisma.message.findUnique({ where: { id: messageId } }),
    );
    expect(message?.status).toBe('sent');
    expect(message?.sentAt).not.toBeNull();
    expect(message?.provider).toBe('amazon-ses');
    expect(message?.providerMessageId).toBe(MOCK_PROVIDER_MESSAGE_ID);
    expect(message?.channel).toBe('email');
    expect(message?.generatedText).toBe(MOCK_GENERATED_TEXT);

    // (6b) CampaignTarget → sent (the three-state tombstone reached terminal).
    const target = await assertRead(() =>
      prisma.campaignTarget.findUnique({ where: { messageId } }),
    );
    expect(target?.status).toBe('sent');
    expect(target?.sentAt).not.toBeNull();
    expect(target?.sendStartedAt).not.toBeNull();

    // (6c) Quota bucket — today's UTC-day row incremented to 1.
    const buckets = await assertRead(() =>
      prisma.messageQuotaBucket.findMany({ where: { merchantId } }),
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.sentCount).toBe(1);

    // (6d) dispatch.sent audit — providerMessageId + ids in context; NO PII
    // (no recipient address, no body).
    const audits = await assertRead(() =>
      prisma.auditLog.findMany({
        where: { merchantId, action: AUDIT_ACTIONS.dispatch.sent },
      }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.targetId).toBe(messageId);
    expect(audits[0]?.context).toMatchObject({
      campaignId,
      customerId: targetCustomerId,
      providerMessageId: MOCK_PROVIDER_MESSAGE_ID,
    });

    // (6e) NO Suppression row on the happy path (8.4 writes none).
    const suppressions = await assertRead(() =>
      prisma.suppression.findMany({ where: { merchantId } }),
    );
    expect(suppressions).toHaveLength(0);

    // (6f) Mock SES called exactly once with the right shape: recipient =
    // target's email, body = the generated text, correlationId = messageId,
    // configurationSetName forwarded.
    expect(mockSesSend).toHaveBeenCalledTimes(1);
    const sendArgs = mockSesSend.mock.calls[0]?.[0] as EmailSendArgs;
    expect(sendArgs.from).toBe(FROM_ADDRESS);
    expect(sendArgs.to).toBe('alice@example.com');
    expect(sendArgs.html).toBe(MOCK_GENERATED_TEXT);
    expect(sendArgs.correlationId).toBe(messageId);
    expect(sendArgs.configurationSetName).toBe(CONFIG_SET);

    // (6g) Enqueue signal integrity — exactly one customer.state_changed
    // OutboxEvent produced by the sweep (single lapse, no duplicate).
    const outbox = await assertRead(() =>
      prisma.outboxEvent.count({
        where: { merchantId, type: OUTBOX_EVENTS.customer.state_changed },
      }),
    );
    expect(outbox).toBe(1);

    // (6h) Fillers never entered the pipeline: no draft/sent messages, no
    // targets. Proves the sweep + pickup didn't fan out to unchanged customers.
    const fillerMessages = await assertRead(() =>
      prisma.message.count({
        where: { merchantId, customerId: { in: fillerCustomerIds } },
      }),
    );
    expect(fillerMessages).toBe(0);
    const fillerTargets = await assertRead(() =>
      prisma.campaignTarget.count({
        where: { merchantId, customerId: { in: fillerCustomerIds } },
      }),
    );
    expect(fillerTargets).toBe(0);
  });
});
