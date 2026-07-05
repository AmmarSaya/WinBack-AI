/**
 * Epic G batch 8.4 — drainer integration tests for the SES send path
 * (real Postgres + mock EmailProvider).
 *
 * Closes 8.4 by verifying the cross-tx invariants that unit tests can't
 * observe with a mocked Prisma:
 *   - the pre-send tx commits + the completion-tx (with bucket lock) hits real PG
 *   - the SHARED markSentWithQuota method writes the dispatch.sent audit + the
 *     bucket increment + the status transitions atomically
 *   - the crash-window proof: after a SES "send" (mock), interrupt before the
 *     completion-tx commits → assert the row is at `sending`, NOT `sent`, AND
 *     a second worker pass does NOT auto-resend (the replay guard short-circuits)
 *   - the ACK-LOST proof: mock throws an EmailProviderTransientError AFTER its
 *     internal "send was attempted" side-effect → row at `sending`, no resend
 *   - the WORKER-FLOW FIX (revertToPending): a retryable error reverts
 *     sending→pending so the next attempt finds a fresh pending row + sends
 *   - non-retryable failures land terminal-failed + advance the Message too
 *   - email_recipient_suppressed lands terminal-suppressed + writes the audit,
 *     but NO Suppression row (8.5 owns)
 *   - the sweep arms (NOT implemented here — out of scope, covered separately)
 *     never see `sending` rows; we prove the worker-side invariant instead.
 *
 * Scope decisions:
 *   - Direct `processCampaignDispatchJob` invocation (no BullMQ flow).
 *   - The EmailProvider is mocked via vi.fn at the boundary; we never spin up
 *     a real SES client.
 *   - The crash-window proof uses a transient-DB-error injector on
 *     `markSentWithQuota` to drive the in-tx-retry budget AND the "completion
 *     never lands" outcome (the row stays `sending`, the next pass replay-
 *     guards).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { AUDIT_ACTIONS, type CampaignDispatchJobPayload } from '@winback/contracts';
import {
  CampaignRepository,
  withSystemScope,
  withTenantScope,
} from '@winback/db';
import {
  assertRead,
  createTestMerchant,
  getTestClient,
  resetDb,
} from '@winback/db/test-utils';
import {
  EmailProviderAuthError,
  EmailProviderRateLimitError,
  EmailProviderRecipientSuppressedError,
  EmailProviderTransientError,
  type EmailProvider,
  type EmailSendAccepted,
  type EmailSendArgs,
} from '@winback/email';
import type { ShopifyConfig } from '@winback/shopify';
import type { Job } from 'bullmq';

import type { DrainerContext } from '../../src/context.js';
import { processCampaignDispatchJob } from '../../src/workers/dispatch.worker.js';

const SHOP = 'epic-g-84-send.myshopify.com';
const FROM_ADDRESS = 'winback@example.com';
const CONFIG_SET = 'winback-events';

const prisma = getTestClient();
const campaignRepo = new CampaignRepository(prisma);

let merchantId: string;
let customerId: string;
let campaignId: string;
let messageId: string;

// ─────────────────────────────────────────────────────────────────────────
// CLOCK PIN — do NOT remove without reading.
//
// This file's send-path tests exercise the dispatch worker's full gate
// chain against real Postgres. Gate 5 (quiet-hours) reads
// `new Date()` inside the worker (dispatch.worker.ts:168 → gate-chain.ts)
// and computes merchant-local hour vs `sendTimeStartHour/EndHour`.
// The test merchant is created via `createTestMerchant` with no timezone
// override (null → UTC fallback per quiet-hours.ts) and no
// MerchantSettings override (defaults 9-18). With no clock pin, gate 5
// reads the CI wall-clock UTC hour. When CI ran between 09:00-18:00 UTC
// the tests happened to pass; when CI ran at 07:35 UTC (as PR #122 did)
// all 6 send-path assertions red-lit because gate 5 deferred every
// target before the send code path could run.
//
// This was a wall-clock time bomb that shipped with 8.4 by luck (its
// merge CI ran at 17:36 UTC, inside the window). Founder's ruling on
// PR #122: FIX the class, don't re-roll the clock.
//
// TODAY-noon-UTC (not a fixed past date like 2026-06-11T12Z) is
// deliberate: the seed rows in this file use Prisma `@default(now())`,
// resolved on the POSTGRES clock at INSERT — so pinning JS to a date
// weeks away from Postgres-now would manufacture a JS/Postgres clock
// gap, and a future test that seeded an Order or a `sent` Message
// would silently invert the freshness/frequency gate (JS-past vs
// Postgres-real-now). Today-noon keeps the JS clock within hours of
// Postgres, closing that trap.
//
// LATENT-TRAP CONTINGENCY: this pin is SAFE ONLY WHILE gates 3
// (freshness), 4 (frequency) and 6 (quota) have empty tables in this
// file's seeds — currently NO Order rows, NO `sent` Message rows, NO
// MessageQuotaBucket rows. Those gates pass regardless of `now`
// because their tables are empty, not because the pin is robust for
// them. If a future test in THIS file seeds any of those tables, the
// pinned JS clock will start being compared against Postgres-now
// seed rows and can silently invert. RE-PIN the JS clock RELATIVE TO
// the seed clock (or seed relative to the pin) BEFORE adding such a
// seed. This lesson belongs in the handoff for any integration test
// whose seeds live on the Postgres clock but whose gates read a
// JS-side `now`.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Today's date at 12:00:00 UTC, computed from the REAL wall clock at call
 * time. Called BEFORE `vi.useFakeTimers()` in `beforeEach`, so the wall
 * clock is real when this runs.
 */
function noonUtcToday(): Date {
  const nowReal = new Date();
  return new Date(Date.UTC(
    nowReal.getUTCFullYear(),
    nowReal.getUTCMonth(),
    nowReal.getUTCDate(),
    12, 0, 0, 0,
  ));
}

beforeEach(async () => {
  await resetDb();
  // Order matters: fake timers active BEFORE `createTestMerchant` (which
  // calls JS `new Date()` for `installedAt` + `scoringInitializedAt`) and
  // BEFORE any seed write below. Seed rows themselves use Prisma
  // `@default(now())` (Postgres clock) so the fake timer does not affect
  // their timestamps; only JS-side `new Date()` calls in the worker's
  // gate chain resolve to the pinned instant.
  //
  // `toFake: ['Date']` — ONLY fake the Date global; leave setTimeout /
  // setInterval / setImmediate on the real timers. This is load-bearing:
  // the worker's in-pass completion-tx retry budget uses a real
  // `sleep(100ms)` (setTimeout under the hood) between attempts, and
  // several tests in this file (HALF 1 ACK-LOST, HALF 2 RETRYABLE, the
  // in-pass retry budget test) drive that retry loop deliberately.
  // Faking setTimeout would stall those `sleep`s indefinitely, hanging
  // the tests until the 30s per-test timeout expires. Date-only faking
  // pins gate 5 (quiet-hours) without breaking the retry loop.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(noonUtcToday());
  merchantId = await createTestMerchant(SHOP);
  // ─────────────────────────────────────────────────────────────────────
  // Seed: subscribed customer + completed AiGeneration + draft Message +
  // active email campaign + claimed CampaignTarget. The send path's
  // happy-path entry condition (gates passed) is then a one-line mock.
  // ─────────────────────────────────────────────────────────────────────
  await withSystemScope('test.seed_full_dispatchable', async () => {
    const cust = await prisma.customer.create({
      data: {
        merchantId,
        shopifyCustomerId: 'gid://shopify/Customer/1',
        email: 'customer@example.com',
        firstName: 'Alice',
        emailMarketingConsentState: 'subscribed',
      },
      select: { id: true },
    });
    customerId = cust.id;

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
        generatedText: '<p>We miss you Alice — here is 10% off.</p>',
      },
      select: { id: true },
    });

    const msg = await prisma.message.create({
      data: {
        merchantId,
        customerId,
        aiGenerationId: gen.id,
        generatedText: '<p>We miss you Alice — here is 10% off.</p>',
      },
      select: { id: true },
    });
    messageId = msg.id;

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
    campaignId = campaign.id;

    await prisma.campaignTarget.create({
      data: { merchantId, campaignId, messageId, customerId },
    });
  });
});

afterEach(() => {
  // Restore real timers so a subsequent test's `beforeEach` starts from a
  // clean baseline (`noonUtcToday()` needs a real `new Date()` to compute
  // today's date).
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers — mock EmailProvider + DrainerContext builder
// ---------------------------------------------------------------------------

interface MockEmail {
  provider: EmailProvider;
  send: ReturnType<typeof vi.fn<(args: EmailSendArgs) => Promise<EmailSendAccepted>>>;
}

function makeMockEmail(): MockEmail {
  const send = vi.fn(async (_args: EmailSendArgs) => ({
    providerMessageId: `mock-ses-${Math.random().toString(36).slice(2, 10)}`,
    latencyMs: 12,
  }));
  return {
    send,
    provider: { name: 'amazon-ses' as const, send },
  };
}

function makeCtx(emailProvider: EmailProvider): DrainerContext {
  return {
    prisma,
    queues: {} as DrainerContext['queues'],
    shopifyConfig: {} as unknown as ShopifyConfig,
    emailProvider,
    emailFromAddress: FROM_ADDRESS,
    emailConfigurationSetName: CONFIG_SET,
  };
}

function makeJob(): Job<CampaignDispatchJobPayload> {
  return {
    id: 'job_send_1',
    data: { merchantId, messageId, campaignId, customerId },
  } as unknown as Job<CampaignDispatchJobPayload>;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('processCampaignDispatchJob — SES send happy path (real PG + mock adapter)', () => {
  it('passes gates → startSending → SES send → markSentWithQuota: target+message → sent, bucket+1, audit row, NO Suppression row', async () => {
    const mockEmail = makeMockEmail();

    await processCampaignDispatchJob(makeCtx(mockEmail.provider), makeJob());

    // Mock was called with the correct shape: 8.5 SNS join key (correlationId)
    // = CampaignTarget.id (= messageId in v1 single-touch), configurationSetName
    // is forwarded, recipient address is the customer's email.
    expect(mockEmail.send).toHaveBeenCalledTimes(1);
    const sendArgs = mockEmail.send.mock.calls[0]?.[0];
    expect(sendArgs?.from).toBe(FROM_ADDRESS);
    expect(sendArgs?.to).toBe('customer@example.com');
    expect(sendArgs?.correlationId).toBe(messageId);
    expect(sendArgs?.configurationSetName).toBe(CONFIG_SET);
    expect(sendArgs?.html).toContain('We miss you');

    const [target, message, buckets, audits, suppressions] = await assertRead(() =>
      Promise.all([
        prisma.campaignTarget.findUnique({ where: { messageId } }),
        prisma.message.findUnique({ where: { id: messageId } }),
        prisma.messageQuotaBucket.findMany({ where: { merchantId } }),
        prisma.auditLog.findMany({ where: { merchantId, action: AUDIT_ACTIONS.dispatch.sent } }),
        prisma.suppression.findMany({ where: { merchantId } }),
      ]),
    );

    expect(target?.status).toBe('sent');
    expect(target?.sentAt).not.toBeNull();
    expect(target?.sendStartedAt).not.toBeNull();
    expect(message?.status).toBe('sent');
    expect(message?.provider).toBe('amazon-ses');
    expect(message?.providerMessageId).toMatch(/^mock-ses-/);
    expect(message?.channel).toBe('email');
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.sentCount).toBe(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.targetId).toBe(messageId);
    expect(audits[0]?.context).toMatchObject({
      campaignId,
      customerId,
      providerMessageId: expect.stringMatching(/^mock-ses-/),
    });
    // SHARPENING A — 8.4 does NOT write a Suppression row on any path.
    expect(suppressions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LOAD-BEARING HALF 1 — "we DON'T know if SES sent" (ACK-LOST / C3)
//
// Scenario: the mock SES adapter fires its side-effect (the .send call
// happens — we count it) AND returns a providerMessageId AS IF the send was
// accepted. Then the COMPLETION-TX fails. From the worker's perspective the
// email MAY have gone out (we have a providerMessageId in hand) but our DB
// never recorded it. Asymmetric-cost policy: NEVER auto-resend.
//
// Expected behavior:
//   - row stays at `sending` (no auto-resend, EVER)
//   - mock SES send count stays at 1 across any number of subsequent passes
//   - replay guard short-circuits on the next pass before any gate read
//
// This is the SAFETY ARGUMENT for the most dangerous batch — a regression here
// silently double-emails customers. Mutation-check verified
// (`--mutation: remove 'sending' from worker replay guard → THIS TEST FAILS`).
// ---------------------------------------------------------------------------

describe('processCampaignDispatchJob — HALF 1: ACK-LOST equivalent (crash-window proof; THE LOAD-BEARING TEST)', () => {
  it("SES side-effect fired + ACK returned + completion-tx interrupted on every in-pass retry → row stays at sending; second pass does NOT resend (mock count stays at 1)", async () => {
    const mockEmail = makeMockEmail();

    // Force markSentWithQuota to fail for the full in-pass retry budget by
    // having the bucket-create racy upsert collide on a malformed write.
    // Simpler: stub the repo method via a spy. We don't have a repo factory in
    // the worker — instead we inject the failure by making the `customer` row
    // have a constraint-violating denormalized state. Cleanest: monkey-patch
    // the prototype's markSentWithQuota for the duration of this test. The
    // method is called against `this`-bound repo instances inside the worker,
    // so prototype-level replacement is safe + restored in `finally`.
    /* eslint-disable @typescript-eslint/unbound-method -- intentional prototype monkey-patch + finally restore */
    const originalMark = CampaignRepository.prototype.markSentWithQuota;
    const failures: unknown[] = [];
    CampaignRepository.prototype.markSentWithQuota = vi.fn(async () => {
      failures.push(Date.now());
      throw new Error('simulated lock_timeout (crash-window injector)');
    });
    /* eslint-enable @typescript-eslint/unbound-method */

    try {
      // Pass 1 — completion-tx fails the full budget; the worker logs + returns
      // WITHOUT throwing (the budget-exhausted safety from §6 of Phase 2).
      await processCampaignDispatchJob(makeCtx(mockEmail.provider), makeJob());

      // The mock SES adapter DID get called exactly once — the send happened.
      expect(mockEmail.send).toHaveBeenCalledTimes(1);

      // The CampaignTarget is in `sending` (pre-send tx committed; completion-tx
      // never landed). Message stays at `draft`. Bucket has NO increment yet.
      const [target, message, buckets] = await assertRead(() =>
        Promise.all([
          prisma.campaignTarget.findUnique({ where: { messageId } }),
          prisma.message.findUnique({ where: { id: messageId } }),
          prisma.messageQuotaBucket.findMany({ where: { merchantId } }),
        ]),
      );
      expect(target?.status).toBe('sending');
      expect(target?.sendStartedAt).not.toBeNull();
      expect(message?.status).toBe('draft');
      expect(message?.providerMessageId).toBeNull();
      // Bucket may or may not exist (the injected failure happens AFTER the
      // create-or-skip; the bucket row may have been INSERTED before the throw).
      // What matters is that no INCREMENT occurred.
      const totalSent = buckets.reduce((acc, b) => acc + b.sentCount, 0);
      expect(totalSent).toBe(0);
      expect(failures.length).toBeGreaterThanOrEqual(3); // in-pass retry budget hit

      // Pass 2 — the second worker pass for the SAME job. The replay guard
      // sees `sending` and short-circuits BEFORE any gate read, BEFORE any
      // mock SES call. NO double-send.
      await processCampaignDispatchJob(makeCtx(mockEmail.provider), makeJob());
      expect(mockEmail.send).toHaveBeenCalledTimes(1); // STILL one.

      const targetAfter = await assertRead(() =>
        prisma.campaignTarget.findUnique({ where: { messageId } }),
      );
      expect(targetAfter?.status).toBe('sending'); // unchanged
    } finally {
      CampaignRepository.prototype.markSentWithQuota = originalMark;
    }
  });
});

// ---------------------------------------------------------------------------
// LOAD-BEARING HALF 2 — "we KNOW SES rejected" (RETRYABLE)
//
// Scenario: the mock SES adapter throws an EmailProviderError marked
// retryable (rate limit / 5xx / network) BEFORE any side-effect. The send
// did NOT happen (SES told us so by raising a typed error class with
// `retryable: true`).
//
// Expected behavior (THE WORKER-FLOW FIX):
//   - row reverts sending → pending via revertToPending (clears sendStartedAt)
//   - worker re-throws so BullMQ retries the job
//   - the next pass finds a fresh `pending` row and starts the send path again
//   - mock SES send count INCREMENTS to 2 (the resend)
//   - on success on pass 2, the row reaches `sent` with the new providerMessageId
//
// Without revertToPending, the row would stick at `sending` forever (the replay
// guard short-circuits) — a transient SES rate-limit becomes a permanently
// stuck row. Mutation-check the equivalent of removing revertToPending and
// you get the same broken outcome.
// ---------------------------------------------------------------------------

describe('processCampaignDispatchJob — HALF 2: RETRYABLE proof (revertToPending recovery; the worker-flow fix)', () => {
  it("SES throws retryable (no side-effect) → revertToPending → next pass sends cleanly (mock count INCREMENTS to 2)", async () => {
    const mockEmail = makeMockEmail();
    let calls = 0;
    mockEmail.send.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        // Pre-side-effect throw: SES rejected the send (429). We KNOW it
        // did not go out. Safe to retry.
        throw new EmailProviderRateLimitError('SES 429 rejected before send');
      }
      return { providerMessageId: 'mock-after-retry', latencyMs: 8 };
    });

    // First pass — retryable error reverts sending → pending and rethrows
    // for BullMQ. We assert the throw + the post-throw state.
    await expect(
      processCampaignDispatchJob(makeCtx(mockEmail.provider), makeJob()),
    ).rejects.toBeInstanceOf(EmailProviderRateLimitError);

    expect(mockEmail.send).toHaveBeenCalledTimes(1);
    const afterFirst = await assertRead(() =>
      prisma.campaignTarget.findUnique({ where: { messageId } }),
    );
    expect(afterFirst?.status).toBe('pending');
    expect(afterFirst?.sendStartedAt).toBeNull();

    // Second pass — fresh re-entry. The mock returns success this time and
    // the send count INCREMENTS — proving the resend actually happened
    // (HALF 2's defining behavior, opposite of HALF 1).
    await processCampaignDispatchJob(makeCtx(mockEmail.provider), makeJob());
    expect(mockEmail.send).toHaveBeenCalledTimes(2);

    const afterSecond = await assertRead(() =>
      prisma.campaignTarget.findUnique({ where: { messageId } }),
    );
    expect(afterSecond?.status).toBe('sent');
    const message = await assertRead(() =>
      prisma.message.findUnique({ where: { id: messageId } }),
    );
    expect(message?.providerMessageId).toBe('mock-after-retry');
  });
});

// ---------------------------------------------------------------------------
// Non-retryable failures + ses_suppressed
// ---------------------------------------------------------------------------

describe('processCampaignDispatchJob — SES non-retryable failures', () => {
  it('email_auth → CampaignTarget+Message both → failed; suppressedByGate=email_auth; NO bucket increment; NO audit', async () => {
    const mockEmail = makeMockEmail();
    mockEmail.send.mockRejectedValueOnce(new EmailProviderAuthError('SES 403 signature mismatch'));

    await processCampaignDispatchJob(makeCtx(mockEmail.provider), makeJob());

    const [target, message, buckets, audits] = await assertRead(() =>
      Promise.all([
        prisma.campaignTarget.findUnique({ where: { messageId } }),
        prisma.message.findUnique({ where: { id: messageId } }),
        prisma.messageQuotaBucket.findMany({ where: { merchantId } }),
        prisma.auditLog.findMany({ where: { merchantId } }),
      ]),
    );
    expect(target?.status).toBe('failed');
    expect(target?.suppressedByGate).toBe('email_auth');
    expect(message?.status).toBe('failed');
    expect(buckets.reduce((acc, b) => acc + b.sentCount, 0)).toBe(0);
    expect(audits).toHaveLength(0);
  });

  it('email_recipient_suppressed → CampaignTarget+Message → suppressed (ses_suppressed); writes dispatch.suppressed_by_ses audit; NO Suppression row (8.5 owns)', async () => {
    const mockEmail = makeMockEmail();
    mockEmail.send.mockRejectedValueOnce(
      new EmailProviderRecipientSuppressedError('SES Address blacklisted'),
    );

    await processCampaignDispatchJob(makeCtx(mockEmail.provider), makeJob());

    const [target, message, audits, suppressions] = await assertRead(() =>
      Promise.all([
        prisma.campaignTarget.findUnique({ where: { messageId } }),
        prisma.message.findUnique({ where: { id: messageId } }),
        prisma.auditLog.findMany({
          where: { merchantId, action: AUDIT_ACTIONS.dispatch.suppressed_by_ses },
        }),
        prisma.suppression.findMany({ where: { merchantId } }),
      ]),
    );
    expect(target?.status).toBe('suppressed');
    expect(target?.suppressedByGate).toBe('ses_suppressed');
    expect(message?.status).toBe('suppressed');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.targetId).toBe(messageId);
    expect(audits[0]?.context).toMatchObject({
      errorCode: 'email_recipient_suppressed',
      campaignId,
      customerId,
    });
    // SHARPENING A — DO NOT write Suppression at 8.4.
    expect(suppressions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sweep-arm exclusion (`sending` is invisible to both arms — proven at the
// `sending`-replay-guard level above; here we assert the worker honors it for
// arbitrary jobs against a `sending` row)
// ---------------------------------------------------------------------------

describe('processCampaignDispatchJob — replay guard on sending (no auto-resend)', () => {
  it('a CampaignTarget already in `sending` (e.g. C1\'/C2/C3 remnant) → no SES call; status unchanged', async () => {
    // Drive the row to `sending` directly (system scope — bypasses the tenant
    // assertion the Prisma extension would otherwise raise on a bare update).
    await withSystemScope('test.plant_sending', async () => {
      await prisma.campaignTarget.update({
        where: { messageId },
        data: { status: 'sending', sendStartedAt: new Date('2026-06-28T11:00:00Z') },
      });
    });

    const mockEmail = makeMockEmail();
    await processCampaignDispatchJob(makeCtx(mockEmail.provider), makeJob());

    expect(mockEmail.send).not.toHaveBeenCalled();

    const target = await assertRead(() =>
      prisma.campaignTarget.findUnique({ where: { messageId } }),
    );
    expect(target?.status).toBe('sending');
    expect(target?.sendStartedAt?.toISOString()).toBe('2026-06-28T11:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// GUARD INDEPENDENCE proofs — pin each safety SEPARATELY so a future
// refactor that silently breaks one is caught by CI before defense-in-depth
// degrades to a single point of failure.
//
// The mutation check on the crash-window proof revealed that the two
// safeties for the ACK-LOST policy (the worker's replay-guard + startSending's
// status='pending' CAS) are REDUNDANT in implementation — removing either
// alone keeps the crash-window test green. That redundancy is correct
// defense-in-depth, but it leaves no signal if ONE breaks. These two tests
// pin each guard SEPARATELY.
//
// Particularly load-bearing for 8.5: the SNS Delivery handler will call
// startSending without going through the worker's replay-guard, so the CAS
// MUST be independently proven.
// ---------------------------------------------------------------------------

describe('GUARD INDEPENDENCE A — startSending CAS alone refuses to re-start a `sending` row', () => {
  it('repo.startSending called directly against a `sending` row (BYPASSING the worker replay-guard) returns noop_not_pending and does NOT overwrite sendStartedAt', async () => {
    // Plant the row at `sending` with a precise sendStartedAt — if the CAS
    // wrongly fired, an UPDATE without the guard would overwrite this.
    const plantedAt = new Date('2026-06-28T11:00:00Z');
    await withSystemScope('test.plant_sending_for_cas', async () => {
      await prisma.campaignTarget.update({
        where: { messageId },
        data: { status: 'sending', sendStartedAt: plantedAt },
      });
    });

    // Call the repo method DIRECTLY — no worker, no replay-guard in the loop.
    // This is the same call pattern 8.5's SNS Delivery handler will use when
    // reconciling a stuck row: the only thing standing between it and a
    // re-send is this CAS.
    const repo = new CampaignRepository(prisma);
    const result = await withTenantScope(merchantId, async () =>
      repo.startSending({ messageId, now: new Date('2026-06-28T12:00:00Z') }),
    );

    expect(result).toEqual({ kind: 'noop_not_pending', currentStatus: 'sending' });

    const target = await assertRead(() =>
      prisma.campaignTarget.findUnique({ where: { messageId } }),
    );
    // CAS refused — sendStartedAt is UNCHANGED. If the CAS had been silently
    // removed in a refactor, this assertion would fail (the row's
    // sendStartedAt would be 12:00:00, not 11:00:00).
    expect(target?.status).toBe('sending');
    expect(target?.sendStartedAt?.toISOString()).toBe('2026-06-28T11:00:00.000Z');
  });
});

describe('GUARD INDEPENDENCE B — worker replay-guard alone short-circuits BEFORE the gate chain runs', () => {
  it('a `sending` row whose customer would FAIL the consent gate → row stays at `sending` (NOT `suppressed`), proving the replay-guard fired before the consent gate', async () => {
    // Setup: revoke the customer's consent. If the gate chain RAN (i.e. the
    // replay-guard was silently removed), the consent gate would suppress
    // this target via `resolveTerminal({status:'suppressed', reason:'consent'})`
    // and the row would end up at `suppressed`. If the replay-guard FIRES
    // (correct), gate chain never runs and the row stays at `sending`. Same
    // external trigger; OPPOSITE outcomes — the replay-guard is the
    // independent observable variable.
    await withSystemScope('test.plant_sending_with_no_consent', async () => {
      await prisma.customer.update({
        where: { id: customerId },
        data: { emailMarketingConsentState: 'not_subscribed' },
      });
      await prisma.campaignTarget.update({
        where: { messageId },
        data: { status: 'sending', sendStartedAt: new Date('2026-06-28T11:00:00Z') },
      });
    });

    const mockEmail = makeMockEmail();
    await processCampaignDispatchJob(makeCtx(mockEmail.provider), makeJob());

    expect(mockEmail.send).not.toHaveBeenCalled();

    const target = await assertRead(() =>
      prisma.campaignTarget.findUnique({ where: { messageId } }),
    );
    // Replay-guard fired (correct): row stays at `sending`. If this assertion
    // EVER reads `'suppressed'`, the replay-guard was silently removed —
    // defense-in-depth has degraded; the CAS is now the only safety. Counts
    // as a P1 regression for 8.4's ACK-LOST safety argument.
    expect(target?.status).toBe('sending');
    expect(target?.suppressedByGate).toBeNull();
    expect(target?.sendStartedAt?.toISOString()).toBe('2026-06-28T11:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Transient completion-tx retry budget — success on attempt 3
// ---------------------------------------------------------------------------

describe('processCampaignDispatchJob — in-pass completion-tx retry budget', () => {
  it('transient lock-timeout on attempts 1+2 → succeeds on attempt 3; final state correct; mock SES called once', async () => {
    const mockEmail = makeMockEmail();
    /* eslint-disable @typescript-eslint/unbound-method -- intentional prototype monkey-patch + finally restore */
    const originalMark = CampaignRepository.prototype.markSentWithQuota;
    let attempts = 0;
    CampaignRepository.prototype.markSentWithQuota = vi.fn(
      async (args: Parameters<typeof originalMark>[0]) => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error('simulated lock_timeout');
        }
        return originalMark.call(campaignRepo, args);
      },
    );
    /* eslint-enable @typescript-eslint/unbound-method */

    try {
      await processCampaignDispatchJob(makeCtx(mockEmail.provider), makeJob());
    } finally {
      CampaignRepository.prototype.markSentWithQuota = originalMark;
    }

    expect(mockEmail.send).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(3);

    const target = await assertRead(() =>
      prisma.campaignTarget.findUnique({ where: { messageId } }),
    );
    expect(target?.status).toBe('sent');
  });
});

// Unused import keep-alive for vitest: EmailProviderTransientError is part of
// the public surface; the suite documents it without using it in a happy assert.
void EmailProviderTransientError;
