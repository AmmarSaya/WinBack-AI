/**
 * Integration tests for the campaign dispatch SKELETON (Epic G batch 8.2)
 * against real Postgres (`pnpm db:test`).
 *
 * Why this file exists: the dispatch pickup's correctness lives entirely in
 * raw SQL — the `DISTINCT ON` oldest-campaign tiebreak, the
 * completed-generation + non-empty-body gate, the soft-delete exclusion, and
 * the `NOT EXISTS CampaignTarget` idempotency pre-filter. The unit test
 * (`campaign-repository.test.ts`) mocks `$queryRaw` and so can only verify the
 * wrapper. These tests pin the SQL behavior by execution against seeded data.
 *
 * THE LOAD-BEARING TEST is `two-tick idempotency`. In the skeleton, the ONLY
 * thing that stops a re-tick from claiming a draft a SECOND time is the
 * pickup's `NOT EXISTS CampaignTarget` clause plus the `CampaignTarget.messageId
 * @unique` constraint — the skeleton deliberately does NOT change
 * `Message.status` (it stays `draft`), so there is no backup signal. A bug here
 * silently creates a duplicate `CampaignTarget` every 15-min tick forever and
 * nothing else catches it. So we PROVE it on real Postgres: run the
 * tick(pickup) → worker(claim) cycle, assert ONE CampaignTarget; run the cycle
 * a SECOND time, assert STILL ONE (not two).
 *
 * "tick → worker" here = `findDispatchableDrafts` (the tick's pickup query) +
 * `claimTarget` (the worker's claim) run end-to-end against real Postgres — the
 * two load-bearing DB operations where the duplicate-target bug would hide. The
 * BullMQ transport between them is generic glue, unit-tested separately
 * (scheduling shapes + the worker processor).
 *
 * Harness: real Postgres; `singleFork: true` — tests serialize. Each test
 * `resetDb`s for full isolation (claims persist across the suite otherwise).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { CampaignRepository, withSystemScope, withTenantScope } from '../../src/index.js';

import { assertRead, createTestMerchant, getTestClient, resetDb } from './setup.js';

const SHOP = 'campaign-dispatch.myshopify.com';
const SHOP_B = 'campaign-dispatch-b.myshopify.com';

const prisma = getTestClient();
const repo = new CampaignRepository(prisma);

let merchantId: string;
let custA: string;
let custB: string;

beforeEach(async () => {
  await resetDb();
  merchantId = await createTestMerchant(SHOP);
  custA = await seedCustomer(merchantId, 'gid://shopify/Customer/1');
  custB = await seedCustomer(merchantId, 'gid://shopify/Customer/2');
});

// ---------------------------------------------------------------------------
// Seed helpers — explicit merchantId throughout (system scope does NOT inject).
// ---------------------------------------------------------------------------

async function seedCustomer(
  forMerchantId: string,
  shopifyCustomerId: string,
  opts: { deletedAt?: Date | null } = {},
): Promise<string> {
  return withSystemScope('test.seed_customer', async () => {
    const c = await prisma.customer.create({
      data: {
        merchantId: forMerchantId,
        shopifyCustomerId,
        email: `${shopifyCustomerId.split('/').pop() ?? 'x'}@example.com`,
        deletedAt: opts.deletedAt ?? null,
      },
      select: { id: true },
    });
    return c.id;
  });
}

/**
 * Seed an AiGeneration + its 1:1 draft Message. Mirrors the real lifecycle:
 * the handler creates AiGeneration(pending) + Message(draft, generatedText='');
 * the AI Worker fills generatedText only on completion and never touches
 * Message.status. So a dispatch-ready draft = genStatus 'completed' + non-empty
 * text + Message.status still 'draft'.
 */
async function seedDraft(args: {
  forMerchantId: string;
  customerId: string;
  triggerState: string;
  genStatus?: 'pending' | 'completed' | 'failed';
  text?: string;
}): Promise<{ messageId: string; aiGenerationId: string }> {
  const genStatus = args.genStatus ?? 'completed';
  const text = args.text ?? 'We miss you — here is 10% off.';
  return withSystemScope('test.seed_draft', async () => {
    const gen = await prisma.aiGeneration.create({
      data: {
        merchantId: args.forMerchantId,
        customerId: args.customerId,
        triggerState: args.triggerState,
        previousState: 'active',
        rDays: 120,
        fCount: 2,
        mCents: 5000n,
        currency: 'USD',
        provider: 'deepseek',
        modelId: 'deepseek-chat',
        systemPrompt: 'sys',
        userPrompt: 'usr',
        status: genStatus,
        generatedText: genStatus === 'completed' ? text : null,
      },
      select: { id: true },
    });
    const msg = await prisma.message.create({
      data: {
        merchantId: args.forMerchantId,
        customerId: args.customerId,
        aiGenerationId: gen.id,
        // On a completed generation the worker would have written `text`; a
        // pending/failed generation leaves the draft body empty.
        generatedText: genStatus === 'completed' ? text : '',
        // status defaults to 'draft'.
      },
      select: { id: true },
    });
    return { messageId: msg.id, aiGenerationId: gen.id };
  });
}

async function seedCampaign(args: {
  forMerchantId: string;
  name: string;
  status?: 'draft' | 'active' | 'paused' | 'archived';
  triggerStates: readonly string[];
  createdAt?: Date;
}): Promise<string> {
  return withSystemScope('test.seed_campaign', async () => {
    const c = await prisma.campaign.create({
      data: {
        merchantId: args.forMerchantId,
        name: args.name,
        status: args.status ?? 'active',
        channel: 'email',
        triggerStates: [...args.triggerStates],
        ...(args.createdAt ? { createdAt: args.createdAt } : {}),
      },
      select: { id: true },
    });
    return c.id;
  });
}

function pickup(forMerchantId: string = merchantId) {
  return withTenantScope(forMerchantId, async () =>
    repo.findDispatchableDrafts({ merchantId: forMerchantId }),
  );
}

function countTargets(forMerchantId: string = merchantId): Promise<number> {
  // assertRead = withSystemScope('test.assert', async () => await fn()) — the
  // async-await form keeps the ALS scope alive until the lazy PrismaPromise
  // actually runs (a sync-arrow callback would exit scope first — the
  // b6431dc bug class the helper exists to prevent).
  return assertRead(() => prisma.campaignTarget.count({ where: { merchantId: forMerchantId } }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CampaignRepository.findDispatchableDrafts (integration, real Postgres)', () => {
  it('selects a completed draft whose band matches an active email campaign', async () => {
    const { messageId } = await seedDraft({
      forMerchantId: merchantId,
      customerId: custA,
      triggerState: 'at_risk',
    });
    const campaignId = await seedCampaign({
      forMerchantId: merchantId,
      name: 'At-risk winback',
      triggerStates: ['at_risk'],
    });

    expect(await pickup()).toEqual([{ messageId, customerId: custA, campaignId }]);
  });

  it('excludes drafts whose generation is NOT completed (pending or failed → empty body, never sendable)', async () => {
    await seedCampaign({
      forMerchantId: merchantId,
      name: 'At-risk',
      triggerStates: ['at_risk'],
    });
    await seedDraft({
      forMerchantId: merchantId,
      customerId: custA,
      triggerState: 'at_risk',
      genStatus: 'pending',
    });
    await seedDraft({
      forMerchantId: merchantId,
      customerId: custB,
      triggerState: 'at_risk',
      genStatus: 'failed',
    });

    expect(await pickup()).toEqual([]);
  });

  it('excludes a completed draft with an empty body (no content to send)', async () => {
    await seedCampaign({
      forMerchantId: merchantId,
      name: 'At-risk',
      triggerStates: ['at_risk'],
    });
    // genStatus completed but force an empty body — guards the
    // generatedText <> '' floor independently of the status gate.
    await seedDraft({
      forMerchantId: merchantId,
      customerId: custA,
      triggerState: 'at_risk',
      genStatus: 'completed',
      text: '',
    });

    expect(await pickup()).toEqual([]);
  });

  it('excludes a draft whose band is not in any active campaign triggerStates', async () => {
    await seedCampaign({
      forMerchantId: merchantId,
      name: 'Dormant only',
      triggerStates: ['dormant'],
    });
    await seedDraft({
      forMerchantId: merchantId,
      customerId: custA,
      triggerState: 'at_risk', // band not covered by the dormant campaign
    });

    expect(await pickup()).toEqual([]);
  });

  it('excludes drafts when the only matching campaign is not active (paused)', async () => {
    await seedCampaign({
      forMerchantId: merchantId,
      name: 'Paused at-risk',
      status: 'paused',
      triggerStates: ['at_risk'],
    });
    await seedDraft({
      forMerchantId: merchantId,
      customerId: custA,
      triggerState: 'at_risk',
    });

    expect(await pickup()).toEqual([]);
  });

  it('excludes drafts for a soft-deleted (redacted) customer — raw SQL enforces the soft-delete invariant', async () => {
    await seedCampaign({
      forMerchantId: merchantId,
      name: 'At-risk',
      triggerStates: ['at_risk'],
    });
    const redacted = await seedCustomer(merchantId, 'gid://shopify/Customer/9', {
      deletedAt: new Date('2026-06-01T00:00:00Z'),
    });
    await seedDraft({
      forMerchantId: merchantId,
      customerId: redacted,
      triggerState: 'at_risk',
    });

    expect(await pickup()).toEqual([]);
  });

  it('TIEBREAK: when two active campaigns overlap a band, the OLDEST (createdAt ASC) wins', async () => {
    const older = await seedCampaign({
      forMerchantId: merchantId,
      name: 'Older dormant',
      triggerStates: ['dormant'],
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await seedCampaign({
      forMerchantId: merchantId,
      name: 'Newer dormant',
      triggerStates: ['dormant'],
      createdAt: new Date('2026-05-01T00:00:00Z'),
    });
    const { messageId } = await seedDraft({
      forMerchantId: merchantId,
      customerId: custA,
      triggerState: 'dormant',
    });

    // Exactly ONE row (DISTINCT ON m.id), and its campaign is the older one.
    expect(await pickup()).toEqual([{ messageId, customerId: custA, campaignId: older }]);
  });

  it('isolates by tenant — a different merchant\'s eligible draft is never returned', async () => {
    // Merchant A: eligible draft + campaign.
    const a = await seedDraft({
      forMerchantId: merchantId,
      customerId: custA,
      triggerState: 'at_risk',
    });
    const campA = await seedCampaign({
      forMerchantId: merchantId,
      name: 'A at-risk',
      triggerStates: ['at_risk'],
    });

    // Merchant B: its own eligible draft + campaign.
    const merchantB = await createTestMerchant(SHOP_B);
    const custB1 = await seedCustomer(merchantB, 'gid://shopify/Customer/1');
    await seedDraft({ forMerchantId: merchantB, customerId: custB1, triggerState: 'at_risk' });
    await seedCampaign({ forMerchantId: merchantB, name: 'B at-risk', triggerStates: ['at_risk'] });

    // A's pickup returns ONLY A's draft.
    expect(await pickup(merchantId)).toEqual([
      { messageId: a.messageId, customerId: custA, campaignId: campA },
    ]);
  });
});

describe('CampaignRepository dispatch — claim + two-tick idempotency (integration, real Postgres)', () => {
  it('TWO-TICK IDEMPOTENCY: tick→claim yields ONE CampaignTarget; a second tick→claim yields STILL ONE (not two)', async () => {
    const { messageId } = await seedDraft({
      forMerchantId: merchantId,
      customerId: custA,
      triggerState: 'at_risk',
    });
    const campaignId = await seedCampaign({
      forMerchantId: merchantId,
      name: 'At-risk',
      triggerStates: ['at_risk'],
    });

    // ── TICK 1 ──────────────────────────────────────────────────────────
    const tick1 = await pickup();
    expect(tick1).toEqual([{ messageId, customerId: custA, campaignId }]);

    const claim1 = await withTenantScope(merchantId, async () =>
      repo.claimTarget({ merchantId, campaignId, messageId, customerId: custA }),
    );
    expect(claim1).toBe('claimed');
    expect(await countTargets()).toBe(1);

    // The claimed target is pending, links the right campaign/message/customer.
    const target = await assertRead(() =>
      prisma.campaignTarget.findUnique({ where: { messageId } }),
    );
    expect(target?.status).toBe('pending');
    expect(target?.campaignId).toBe(campaignId);
    expect(target?.customerId).toBe(custA);

    // ── TICK 2 (15 min later) ───────────────────────────────────────────
    // The pickup's NOT EXISTS clause now excludes the already-claimed draft.
    const tick2 = await pickup();
    expect(tick2).toEqual([]);

    // And even if a claim somehow fires again (tick/worker race), the
    // messageId @unique constraint makes it a no-op — STILL one target.
    const claim2 = await withTenantScope(merchantId, async () =>
      repo.claimTarget({ merchantId, campaignId, messageId, customerId: custA }),
    );
    expect(claim2).toBe('already_claimed');
    expect(await countTargets()).toBe(1);
  });
});
