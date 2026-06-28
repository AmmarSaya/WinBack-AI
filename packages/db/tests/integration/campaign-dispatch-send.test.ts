/**
 * Integration tests for the dispatch SEND-path repo methods (Epic G batch
 * 8.4) against real Postgres (`pnpm db:test`).
 *
 * THE LOAD-BEARING METHOD is `markSentWithQuota` — the shared completion-tx
 * the dispatch worker (8.4 happy path) AND 8.5's SNS Delivery handler will
 * both call. A second implementation would drift over time; we pin the
 * behavior here so any future change to the contract is loud.
 *
 * Crash-window semantics are exercised by the drainer integration suite
 * (apps/drainer/tests). This file pins the REPO contracts:
 *   - startSending CAS (pending → sending) + idempotency
 *   - revertToPending CAS (sending → pending) — the worker-flow fix for
 *     retryable SES errors
 *   - markSentWithQuota atomic: bucket lock + increment + status CAS +
 *     Message advance + dispatch.sent audit row, all in one tx
 *   - markSentWithQuota race-replay: a second call after the row went
 *     terminal returns noop_already_terminal AND does NOT double-increment
 *     the bucket
 *   - resolveTerminal widening: status='failed' advances Message → 'failed'
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  AUDIT_ACTIONS,
} from '@winback/contracts';

import {
  CampaignRepository,
  withSystemScope,
  withTenantScope,
} from '../../src/index.js';

import { assertRead, createTestMerchant, getTestClient, resetDb } from './setup.js';

const SHOP = 'campaign-send.myshopify.com';
const prisma = getTestClient();
const repo = new CampaignRepository(prisma);

let merchantId: string;
let customerId: string;

beforeEach(async () => {
  await resetDb();
  merchantId = await createTestMerchant(SHOP);
  customerId = await withSystemScope('test.seed_customer', async () => {
    const c = await prisma.customer.create({
      data: {
        merchantId,
        shopifyCustomerId: 'gid://shopify/Customer/1',
        email: 'customer1@example.com',
        emailMarketingConsentState: 'subscribed',
      },
      select: { id: true },
    });
    return c.id;
  });
});

// ---------------------------------------------------------------------------
// Seed helpers — a complete dispatchable draft + claimed CampaignTarget.
// ---------------------------------------------------------------------------

async function seedClaimedTarget(): Promise<{ messageId: string; campaignId: string }> {
  return withSystemScope('test.seed_draft_and_target', async () => {
    const gen = await prisma.aiGeneration.create({
      data: {
        merchantId,
        customerId,
        triggerState: 'at_risk',
        previousState: 'active',
        rDays: 120,
        fCount: 2,
        mCents: 5000n,
        currency: 'USD',
        provider: 'deepseek',
        modelId: 'deepseek-v4-flash',
        systemPrompt: 'sys',
        userPrompt: 'usr',
        status: 'completed',
        generatedText: 'We miss you — 10% off.',
      },
      select: { id: true },
    });
    const msg = await prisma.message.create({
      data: {
        merchantId,
        customerId,
        aiGenerationId: gen.id,
        generatedText: 'We miss you — 10% off.',
      },
      select: { id: true },
    });
    const campaign = await prisma.campaign.create({
      data: {
        merchantId,
        name: 'At-risk',
        status: 'active',
        channel: 'email',
        triggerStates: ['at_risk'],
      },
      select: { id: true },
    });
    await prisma.campaignTarget.create({
      data: {
        merchantId,
        campaignId: campaign.id,
        messageId: msg.id,
        customerId,
        // status defaults to 'pending'.
      },
    });
    return { messageId: msg.id, campaignId: campaign.id };
  });
}

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// ---------------------------------------------------------------------------
// startSending
// ---------------------------------------------------------------------------

describe('CampaignRepository.startSending — pre-send tombstone CAS (real PG)', () => {
  it('flips pending → sending; stamps sendStartedAt', async () => {
    const { messageId } = await seedClaimedTarget();
    const now = new Date('2026-06-28T12:00:00Z');

    const result = await withTenantScope(merchantId, async () =>
      repo.startSending({ messageId, now }),
    );
    expect(result).toEqual({ kind: 'started' });

    const target = await assertRead(() =>
      prisma.campaignTarget.findUnique({ where: { messageId } }),
    );
    expect(target?.status).toBe('sending');
    expect(target?.sendStartedAt?.toISOString()).toBe('2026-06-28T12:00:00.000Z');
  });

  it('IDEMPOTENT: second call on an already-sending row → noop_not_pending(sending)', async () => {
    const { messageId } = await seedClaimedTarget();
    const now = new Date('2026-06-28T12:00:00Z');
    await withTenantScope(merchantId, async () => repo.startSending({ messageId, now }));

    const second = await withTenantScope(merchantId, async () =>
      repo.startSending({ messageId, now: new Date('2026-06-28T13:00:00Z') }),
    );
    expect(second).toEqual({ kind: 'noop_not_pending', currentStatus: 'sending' });

    // sendStartedAt did NOT get overwritten (the CAS guarded on status='pending').
    const target = await assertRead(() =>
      prisma.campaignTarget.findUnique({ where: { messageId } }),
    );
    expect(target?.sendStartedAt?.toISOString()).toBe('2026-06-28T12:00:00.000Z');
  });

  it('returns noop_target_missing when the row is gone (GDPR cascade)', async () => {
    const { messageId } = await seedClaimedTarget();
    await withSystemScope('test.cascade', async () => {
      await prisma.campaignTarget.delete({ where: { messageId } });
    });

    const result = await withTenantScope(merchantId, async () =>
      repo.startSending({ messageId, now: new Date() }),
    );
    expect(result).toEqual({ kind: 'noop_target_missing' });
  });
});

// ---------------------------------------------------------------------------
// revertToPending — the worker-flow fix for retryable SES errors
// ---------------------------------------------------------------------------

describe('CampaignRepository.revertToPending — retryable SES recovery (real PG)', () => {
  it('flips sending → pending and clears sendStartedAt; idempotent on already-pending', async () => {
    const { messageId } = await seedClaimedTarget();
    const now = new Date('2026-06-28T12:00:00Z');
    await withTenantScope(merchantId, async () => repo.startSending({ messageId, now }));

    const reverted = await withTenantScope(merchantId, async () =>
      repo.revertToPending({ messageId }),
    );
    expect(reverted).toEqual({ reverted: true });

    const target = await assertRead(() =>
      prisma.campaignTarget.findUnique({ where: { messageId } }),
    );
    expect(target?.status).toBe('pending');
    expect(target?.sendStartedAt).toBeNull();

    // Second call (target already back to pending) — CAS-guarded no-op.
    const second = await withTenantScope(merchantId, async () =>
      repo.revertToPending({ messageId }),
    );
    expect(second).toEqual({ reverted: false });
  });

  it('does NOT revert a terminal row (suppressed / sent / failed) — the CAS guard protects them', async () => {
    const { messageId } = await seedClaimedTarget();
    // Force-suppress without going through sending.
    await withTenantScope(merchantId, async () =>
      repo.resolveTerminal({ messageId, reason: 'consent' }),
    );

    const result = await withTenantScope(merchantId, async () =>
      repo.revertToPending({ messageId }),
    );
    expect(result).toEqual({ reverted: false });

    const target = await assertRead(() =>
      prisma.campaignTarget.findUnique({ where: { messageId } }),
    );
    expect(target?.status).toBe('suppressed');
  });

  it('PROOF: after a startSending → revertToPending cycle, a second startSending succeeds (the BullMQ retry re-enters cleanly)', async () => {
    const { messageId } = await seedClaimedTarget();
    const firstNow = new Date('2026-06-28T12:00:00Z');

    // 1st attempt: pending → sending. SES throws retryable. Worker reverts.
    await withTenantScope(merchantId, async () => repo.startSending({ messageId, now: firstNow }));
    await withTenantScope(merchantId, async () => repo.revertToPending({ messageId }));

    // 2nd attempt (BullMQ retry): pending → sending succeeds again.
    const secondNow = new Date('2026-06-28T12:01:00Z');
    const restart = await withTenantScope(merchantId, async () =>
      repo.startSending({ messageId, now: secondNow }),
    );
    expect(restart).toEqual({ kind: 'started' });

    const target = await assertRead(() =>
      prisma.campaignTarget.findUnique({ where: { messageId } }),
    );
    expect(target?.status).toBe('sending');
    expect(target?.sendStartedAt?.toISOString()).toBe('2026-06-28T12:01:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// markSentWithQuota — the shared completion-tx
// ---------------------------------------------------------------------------

describe('CampaignRepository.markSentWithQuota — shared completion-tx (real PG)', () => {
  it('HAPPY PATH: CampaignTarget→sent + Message→sent + bucket+1 + dispatch.sent audit, all atomic', async () => {
    const { messageId, campaignId } = await seedClaimedTarget();
    const now = new Date('2026-06-28T12:00:00Z');
    await withTenantScope(merchantId, async () => repo.startSending({ messageId, now }));

    const result = await withTenantScope(merchantId, async () =>
      repo.markSentWithQuota({
        messageId,
        merchantId,
        shop: SHOP,
        campaignId,
        customerId,
        providerMessageId: 'ses-msg-abc-123',
        now,
      }),
    );
    expect(result).toEqual({ kind: 'sent' });

    const [target, message, bucket, audit] = await assertRead(() =>
      Promise.all([
        prisma.campaignTarget.findUnique({ where: { messageId } }),
        prisma.message.findUnique({ where: { id: messageId } }),
        prisma.messageQuotaBucket.findUnique({
          where: { merchantId_date: { merchantId, date: utcMidnight(now) } },
        }),
        prisma.auditLog.findFirst({
          where: { merchantId, action: AUDIT_ACTIONS.dispatch.sent },
        }),
      ]),
    );

    expect(target?.status).toBe('sent');
    expect(target?.sentAt?.toISOString()).toBe('2026-06-28T12:00:00.000Z');
    expect(message?.status).toBe('sent');
    expect(message?.channel).toBe('email');
    expect(message?.provider).toBe('amazon-ses');
    expect(message?.providerMessageId).toBe('ses-msg-abc-123');
    expect(message?.sentAt?.toISOString()).toBe('2026-06-28T12:00:00.000Z');
    expect(bucket?.sentCount).toBe(1);
    expect(audit?.action).toBe(AUDIT_ACTIONS.dispatch.sent);
    expect(audit?.targetId).toBe(messageId);
    expect(audit?.context).toMatchObject({
      campaignId,
      customerId,
      providerMessageId: 'ses-msg-abc-123',
    });
    // PII / body MUST NOT leak into audit context (rule reminder).
    const context = audit?.context as Record<string, unknown> | null;
    expect(context && 'to' in context).toBe(false);
    expect(context && 'html' in context).toBe(false);
    expect(context && 'recipient' in context).toBe(false);
  });

  it('RACE-REPLAY: a second call after a row already went terminal returns noop_already_terminal AND does NOT double-increment the bucket', async () => {
    const { messageId, campaignId } = await seedClaimedTarget();
    const now = new Date('2026-06-28T12:00:00Z');
    await withTenantScope(merchantId, async () => repo.startSending({ messageId, now }));

    const first = await withTenantScope(merchantId, async () =>
      repo.markSentWithQuota({
        messageId,
        merchantId,
        shop: SHOP,
        campaignId,
        customerId,
        providerMessageId: 'ses-msg-1',
        now,
      }),
    );
    expect(first).toEqual({ kind: 'sent' });

    const second = await withTenantScope(merchantId, async () =>
      repo.markSentWithQuota({
        messageId,
        merchantId,
        shop: SHOP,
        campaignId,
        customerId,
        providerMessageId: 'ses-msg-2',
        now,
      }),
    );
    expect(second).toMatchObject({ kind: 'noop_already_terminal', currentStatus: 'sent' });

    // Bucket stayed at +1 — the second tx aborted before any write.
    const bucket = await assertRead(() =>
      prisma.messageQuotaBucket.findUnique({
        where: { merchantId_date: { merchantId, date: utcMidnight(now) } },
      }),
    );
    expect(bucket?.sentCount).toBe(1);

    // Message did NOT have its providerMessageId overwritten by the race-loser.
    const message = await assertRead(() =>
      prisma.message.findUnique({ where: { id: messageId } }),
    );
    expect(message?.providerMessageId).toBe('ses-msg-1');

    // Exactly ONE dispatch.sent audit row — the race-loser must NOT emit.
    const auditCount = await assertRead(() =>
      prisma.auditLog.count({ where: { merchantId, action: AUDIT_ACTIONS.dispatch.sent } }),
    );
    expect(auditCount).toBe(1);
  });

  it('CONCURRENT BUCKET INSERT: parallel completions for the same merchant + same day end up with exactly ONE bucket row', async () => {
    // Two CampaignTargets, both completing the same day. The first
    // markSentWithQuota INSERTs the bucket; the second hits the P2002
    // unique-violation recovery path AND increments the existing row.
    const t1 = await seedClaimedTarget();
    // A second customer + claimed target.
    const cust2 = await withSystemScope('test.seed_customer2', async () => {
      const c = await prisma.customer.create({
        data: {
          merchantId,
          shopifyCustomerId: 'gid://shopify/Customer/2',
          email: 'customer2@example.com',
          emailMarketingConsentState: 'subscribed',
        },
        select: { id: true },
      });
      return c.id;
    });
    const t2 = await withSystemScope('test.seed_t2', async () => {
      const gen = await prisma.aiGeneration.create({
        data: {
          merchantId,
          customerId: cust2,
          triggerState: 'at_risk',
          previousState: 'active',
          rDays: 120,
          fCount: 2,
          mCents: 5000n,
          currency: 'USD',
          provider: 'deepseek',
          modelId: 'deepseek-v4-flash',
          systemPrompt: 'sys',
          userPrompt: 'usr',
          status: 'completed',
          generatedText: 'second',
        },
        select: { id: true },
      });
      const msg = await prisma.message.create({
        data: {
          merchantId,
          customerId: cust2,
          aiGenerationId: gen.id,
          generatedText: 'second',
        },
        select: { id: true },
      });
      await prisma.campaignTarget.create({
        data: { merchantId, campaignId: t1.campaignId, messageId: msg.id, customerId: cust2 },
      });
      return msg.id;
    });

    const now = new Date('2026-06-28T12:00:00Z');
    await withTenantScope(merchantId, async () => repo.startSending({ messageId: t1.messageId, now }));
    await withTenantScope(merchantId, async () => repo.startSending({ messageId: t2, now }));

    // Sequential completions are sufficient to drive the P2002 recovery
    // branch (the second one finds the bucket from the first and locks it).
    await withTenantScope(merchantId, async () =>
      repo.markSentWithQuota({
        messageId: t1.messageId,
        merchantId,
        shop: SHOP,
        campaignId: t1.campaignId,
        customerId,
        providerMessageId: 'ses-1',
        now,
      }),
    );
    await withTenantScope(merchantId, async () =>
      repo.markSentWithQuota({
        messageId: t2,
        merchantId,
        shop: SHOP,
        campaignId: t1.campaignId,
        customerId: cust2,
        providerMessageId: 'ses-2',
        now,
      }),
    );

    // One bucket row, two increments.
    const buckets = await assertRead(() =>
      prisma.messageQuotaBucket.findMany({ where: { merchantId } }),
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.sentCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// resolveTerminal — 8.4 widening
// ---------------------------------------------------------------------------

describe('CampaignRepository.resolveTerminal — widened to status: suppressed | failed (real PG)', () => {
  it("DEFAULT (8.3 compat): status='suppressed' advances Message → 'suppressed'", async () => {
    const { messageId } = await seedClaimedTarget();
    const result = await withTenantScope(merchantId, async () =>
      repo.resolveTerminal({ messageId, reason: 'consent' }),
    );
    expect(result).toEqual({ resolved: true });
    const target = await assertRead(() =>
      prisma.campaignTarget.findUnique({ where: { messageId } }),
    );
    const message = await assertRead(() =>
      prisma.message.findUnique({ where: { id: messageId } }),
    );
    expect(target?.status).toBe('suppressed');
    expect(target?.suppressedByGate).toBe('consent');
    expect(message?.status).toBe('suppressed');
  });

  it("status='failed' advances Message → 'failed' (a burned draft must not look dispatchable)", async () => {
    const { messageId } = await seedClaimedTarget();
    const result = await withTenantScope(merchantId, async () =>
      repo.resolveTerminal({ messageId, reason: 'email_auth', status: 'failed' }),
    );
    expect(result).toEqual({ resolved: true });
    const target = await assertRead(() =>
      prisma.campaignTarget.findUnique({ where: { messageId } }),
    );
    const message = await assertRead(() =>
      prisma.message.findUnique({ where: { id: messageId } }),
    );
    expect(target?.status).toBe('failed');
    expect(target?.suppressedByGate).toBe('email_auth');
    expect(message?.status).toBe('failed');
  });

  it("resolves from 'sending' state (8.4 — a non-retryable error caught AFTER startSending)", async () => {
    const { messageId } = await seedClaimedTarget();
    const now = new Date('2026-06-28T12:00:00Z');
    await withTenantScope(merchantId, async () => repo.startSending({ messageId, now }));

    const result = await withTenantScope(merchantId, async () =>
      repo.resolveTerminal({ messageId, reason: 'ses_suppressed', status: 'suppressed' }),
    );
    expect(result).toEqual({ resolved: true });

    const target = await assertRead(() =>
      prisma.campaignTarget.findUnique({ where: { messageId } }),
    );
    expect(target?.status).toBe('suppressed');
    expect(target?.suppressedByGate).toBe('ses_suppressed');
  });
});
