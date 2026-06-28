/**
 * Unit tests for the dispatch Worker (Epic G batch 8.3) —
 * `processCampaignDispatchJob` + `createDispatchWorker`.
 *
 * 8.3 turns the worker from claim-only into claim → replay-guard → gate-chain →
 * apply-outcome. The repos + the gate chain are mocked at the module boundary;
 * the real gate logic is unit-tested in `dispatch/gate-chain.test.ts` and the
 * real DB ops against Postgres in the db integration suite. Here we lock the
 * worker's ORCHESTRATION:
 *   - claim is called (idempotent; result discarded);
 *   - REPLAY GUARD: a terminal target does NO gate work (no runGateChain);
 *   - null context → no-op;
 *   - each gate outcome maps to the right write (resolveTerminal / deferTarget /
 *     passed send-stub).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const workerConstructorCalls: {
  name: string;
  opts: { connection: unknown; concurrency: number; lockDuration: number };
}[] = [];

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation((name: string, _processor, opts) => {
    workerConstructorCalls.push({ name, opts });
    return {
      on: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- deliberate no-op close stub
      close: vi.fn(async () => {}),
    };
  }),
}));

const fakeRedisClient = { __fakeRedis: true } as const;
vi.mock('@winback/queue', () => ({
  createRedisClient: vi.fn(() => fakeRedisClient),
}));

const m = vi.hoisted(() => ({
  claimTarget: vi.fn(),
  loadDispatchContext: vi.fn(),
  resolveTerminal: vi.fn(),
  deferTarget: vi.fn(),
  startSending: vi.fn(),
  markSentWithQuota: vi.fn(),
  revertToPending: vi.fn(),
  runGateChain: vi.fn(),
  auditAppend: vi.fn(),
}));

vi.mock('@winback/db', async () => {
  const actual = await vi.importActual<typeof import('@winback/db')>('@winback/db');
  return {
    ...actual,
    withTenantScope: vi.fn(async (_merchantId: unknown, cb: () => Promise<unknown>) => cb()),
    CampaignRepository: vi.fn().mockImplementation(() => ({
      claimTarget: m.claimTarget,
      loadDispatchContext: m.loadDispatchContext,
      resolveTerminal: m.resolveTerminal,
      deferTarget: m.deferTarget,
      startSending: m.startSending,
      markSentWithQuota: m.markSentWithQuota,
      revertToPending: m.revertToPending,
    })),
    OrderRepository: vi.fn().mockImplementation(() => ({})),
    MessageRepository: vi.fn().mockImplementation(() => ({})),
    AuditLogRepository: vi.fn().mockImplementation(() => ({
      append: m.auditAppend,
    })),
  };
});

vi.mock('../../src/dispatch/gate-chain.js', () => ({ runGateChain: m.runGateChain }));

import { QUEUE_NAMES } from '@winback/contracts';
import type { CampaignDispatchJobPayload } from '@winback/contracts';
import type { WinbackPrisma } from '@winback/db';
import { createRedisClient } from '@winback/queue';
import type { ShopifyConfig } from '@winback/shopify';
import type { Job } from 'bullmq';

import type { EmailProvider } from '@winback/email';

import type { DrainerContext } from '../../src/context.js';
import {
  createDispatchWorker,
  processCampaignDispatchJob,
} from '../../src/workers/dispatch.worker.js';

const PAYLOAD: CampaignDispatchJobPayload = {
  merchantId: 'm_1',
  messageId: 'msg_1',
  campaignId: 'camp_1',
  customerId: 'cust_1',
};

const emailSend = vi.fn(async () => ({
  providerMessageId: 'ses-mock-1',
  latencyMs: 12,
}));
const emailProvider: EmailProvider = {
  name: 'amazon-ses',
  send: emailSend,
};

const CTX: DrainerContext = {
  prisma: {} as unknown as WinbackPrisma,
  queues: {} as DrainerContext['queues'],
  shopifyConfig: {} as unknown as ShopifyConfig,
  emailProvider,
  emailFromAddress: 'winback@example.com',
  emailConfigurationSetName: 'winback-events',
};

function makeJob(): Job<CampaignDispatchJobPayload> {
  return { id: 'job_1', data: PAYLOAD } as unknown as Job<CampaignDispatchJobPayload>;
}

// 8.4 — loadDispatchContext returns the send-needed fields now (customerEmail,
// shop, generatedText). The PENDING_CTX is the happy-path baseline; individual
// tests override targetStatus to exercise the replay guard / terminals.
const PENDING_CTX = {
  targetStatus: 'pending',
  customerId: 'cust_1',
  customerEmail: 'customer@example.com',
  shop: 'shop.myshopify.com',
  generatedText: '<p>We miss you</p>',
};

beforeEach(() => {
  workerConstructorCalls.length = 0;
  vi.clearAllMocks();
  m.claimTarget.mockResolvedValue('claimed');
  m.loadDispatchContext.mockResolvedValue(PENDING_CTX);
  m.resolveTerminal.mockResolvedValue({ resolved: true });
  m.deferTarget.mockResolvedValue({ deferred: true });
  // 8.4 send-path defaults: pre-send tx succeeds; SES returns ACK; completion
  // tx succeeds. Tests override individual mocks to exercise failure paths.
  m.startSending.mockResolvedValue({ kind: 'started' });
  m.markSentWithQuota.mockResolvedValue({ kind: 'sent' });
  m.revertToPending.mockResolvedValue({ reverted: true });
  m.auditAppend.mockResolvedValue(undefined);
  emailSend.mockReset();
  emailSend.mockResolvedValue({ providerMessageId: 'ses-mock-1', latencyMs: 12 });
});

describe('processCampaignDispatchJob — claim + context', () => {
  it('always claims (idempotent) then loads the dispatch context', async () => {
    m.runGateChain.mockResolvedValue({ kind: 'passed' });
    await processCampaignDispatchJob(CTX, makeJob());

    expect(m.claimTarget).toHaveBeenCalledWith({
      merchantId: 'm_1',
      campaignId: 'camp_1',
      messageId: 'msg_1',
      customerId: 'cust_1',
    });
    expect(m.loadDispatchContext).toHaveBeenCalledWith({ messageId: 'msg_1' });
  });

  it('null context (target gone / redact cascade) → no-op, NO gate work', async () => {
    m.loadDispatchContext.mockResolvedValue(null);
    await processCampaignDispatchJob(CTX, makeJob());

    expect(m.runGateChain).not.toHaveBeenCalled();
    expect(m.resolveTerminal).not.toHaveBeenCalled();
    expect(m.deferTarget).not.toHaveBeenCalled();
  });

  it('REPLAY GUARD: a terminal target (suppressed) does NO gate work — runGateChain never called', async () => {
    m.loadDispatchContext.mockResolvedValue({ targetStatus: 'suppressed', customerId: 'cust_1' });
    await processCampaignDispatchJob(CTX, makeJob());

    // claim still ran (idempotent), but the guard short-circuited before gates.
    expect(m.claimTarget).toHaveBeenCalledTimes(1);
    expect(m.runGateChain).not.toHaveBeenCalled();
    expect(m.resolveTerminal).not.toHaveBeenCalled();
    expect(m.deferTarget).not.toHaveBeenCalled();
  });

  it.each(['sent', 'failed', 'sending'])(
    'REPLAY GUARD: terminal-or-sending status %s short-circuits (8.4 — sending is the ACK-LOST safety)',
    async (status) => {
      m.loadDispatchContext.mockResolvedValue({ ...PENDING_CTX, targetStatus: status });
      await processCampaignDispatchJob(CTX, makeJob());
      expect(m.runGateChain).not.toHaveBeenCalled();
      // 8.4 — under no circumstances does the worker auto-resend on `sending`.
      expect(emailSend).not.toHaveBeenCalled();
      expect(m.startSending).not.toHaveBeenCalled();
    },
  );
});

describe('processCampaignDispatchJob — outcome application', () => {
  it('suppressed(gate) → resolveTerminal({messageId, reason: gate}); deferTarget NOT called', async () => {
    m.runGateChain.mockResolvedValue({ kind: 'suppressed', gate: 'consent' });
    await processCampaignDispatchJob(CTX, makeJob());

    expect(m.resolveTerminal).toHaveBeenCalledWith({ messageId: 'msg_1', reason: 'consent' });
    expect(m.deferTarget).not.toHaveBeenCalled();
  });

  it('deferred(gate) → deferTarget({messageId}); resolveTerminal NOT called', async () => {
    m.runGateChain.mockResolvedValue({ kind: 'deferred', gate: 'quiet_hours' });
    await processCampaignDispatchJob(CTX, makeJob());

    expect(m.deferTarget).toHaveBeenCalledWith({ messageId: 'msg_1' });
    expect(m.resolveTerminal).not.toHaveBeenCalled();
  });

  it('passed → SES send + completion-tx (startSending → emailProvider.send → markSentWithQuota; NO resolveTerminal, NO deferTarget)', async () => {
    m.runGateChain.mockResolvedValue({ kind: 'passed' });
    await processCampaignDispatchJob(CTX, makeJob());

    expect(m.startSending).toHaveBeenCalledTimes(1);
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(emailSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'winback@example.com',
        to: 'customer@example.com',
        html: '<p>We miss you</p>',
        correlationId: 'msg_1',
        configurationSetName: 'winback-events',
      }),
    );
    expect(m.markSentWithQuota).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg_1',
        merchantId: 'm_1',
        campaignId: 'camp_1',
        customerId: 'cust_1',
        providerMessageId: 'ses-mock-1',
      }),
    );
    expect(m.resolveTerminal).not.toHaveBeenCalled();
    expect(m.deferTarget).not.toHaveBeenCalled();
    expect(m.revertToPending).not.toHaveBeenCalled();
  });

  it('passed + customerEmail null → deferTarget (no send attempted)', async () => {
    m.loadDispatchContext.mockResolvedValue({ ...PENDING_CTX, customerEmail: null });
    m.runGateChain.mockResolvedValue({ kind: 'passed' });
    await processCampaignDispatchJob(CTX, makeJob());

    expect(emailSend).not.toHaveBeenCalled();
    expect(m.startSending).not.toHaveBeenCalled();
    expect(m.deferTarget).toHaveBeenCalledWith({ messageId: 'msg_1' });
    expect(m.markSentWithQuota).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 8.4 SES failure paths — the worker-flow load-bearers
// ===========================================================================

describe('processCampaignDispatchJob — SES failure handling (8.4 worker-flow)', () => {
  it('RETRYABLE error → revertToPending + THROW (the WORKER-FLOW FIX; BullMQ retry re-enters via fresh startSending)', async () => {
    m.runGateChain.mockResolvedValue({ kind: 'passed' });
    // Inline error class to avoid coupling the unit test to package internals.
    const { EmailProviderRateLimitError } = await import('@winback/email');
    emailSend.mockRejectedValueOnce(new EmailProviderRateLimitError('SES 429'));

    await expect(processCampaignDispatchJob(CTX, makeJob())).rejects.toBeInstanceOf(
      EmailProviderRateLimitError,
    );

    expect(m.startSending).toHaveBeenCalledTimes(1);
    expect(m.revertToPending).toHaveBeenCalledWith({ messageId: 'msg_1' });
    expect(m.markSentWithQuota).not.toHaveBeenCalled();
    expect(m.resolveTerminal).not.toHaveBeenCalled();
  });

  it('NON-RETRYABLE email_auth → resolveTerminal(failed); NO revert, NO markSent', async () => {
    m.runGateChain.mockResolvedValue({ kind: 'passed' });
    const { EmailProviderAuthError } = await import('@winback/email');
    emailSend.mockRejectedValueOnce(new EmailProviderAuthError('SES 403'));

    await processCampaignDispatchJob(CTX, makeJob());

    expect(m.resolveTerminal).toHaveBeenCalledWith({
      messageId: 'msg_1',
      reason: 'email_auth',
      status: 'failed',
    });
    expect(m.revertToPending).not.toHaveBeenCalled();
    expect(m.markSentWithQuota).not.toHaveBeenCalled();
    // dispatch.sent NOT written (only the markSentWithQuota path does so), and
    // dispatch.suppressed_by_ses NOT written either (auth ≠ recipient-suppressed).
    expect(m.auditAppend).not.toHaveBeenCalled();
  });

  it('email_recipient_suppressed → resolveTerminal(suppressed, ses_suppressed) + dispatch.suppressed_by_ses audit; NO Suppression row (8.5 owns)', async () => {
    m.runGateChain.mockResolvedValue({ kind: 'passed' });
    const { EmailProviderRecipientSuppressedError } = await import('@winback/email');
    emailSend.mockRejectedValueOnce(
      new EmailProviderRecipientSuppressedError('SES Address blacklisted'),
    );

    await processCampaignDispatchJob(CTX, makeJob());

    expect(m.resolveTerminal).toHaveBeenCalledWith({
      messageId: 'msg_1',
      reason: 'ses_suppressed',
      status: 'suppressed',
    });
    expect(m.auditAppend).toHaveBeenCalledTimes(1);
    expect(m.auditAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'dispatch.suppressed_by_ses',
        targetId: 'msg_1',
        context: expect.objectContaining({ errorCode: 'email_recipient_suppressed' }),
      }),
    );
    expect(m.markSentWithQuota).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 8.4 in-tx retry budget (the C3 safety net)
// ===========================================================================

describe('processCampaignDispatchJob — completion-tx in-pass retry budget', () => {
  it('transient completion-tx failures → retried in-pass (up to 3); success on the 3rd attempt is accepted', async () => {
    m.runGateChain.mockResolvedValue({ kind: 'passed' });
    m.markSentWithQuota
      .mockRejectedValueOnce(new Error('lock_timeout'))
      .mockRejectedValueOnce(new Error('lock_timeout'))
      .mockResolvedValueOnce({ kind: 'sent' });

    await processCampaignDispatchJob(CTX, makeJob());

    expect(m.markSentWithQuota).toHaveBeenCalledTimes(3);
    // Does NOT revert / does NOT throw on in-pass retry success.
    expect(m.revertToPending).not.toHaveBeenCalled();
  });

  it('budget exhausted → log + return WITHOUT throwing (would otherwise hit the replay guard and lose the completion forever)', async () => {
    m.runGateChain.mockResolvedValue({ kind: 'passed' });
    m.markSentWithQuota.mockRejectedValue(new Error('lock_timeout'));

    // Must NOT throw — that would BullMQ-retry → replay guard short-circuits → lost.
    await expect(processCampaignDispatchJob(CTX, makeJob())).resolves.toBeUndefined();

    expect(m.markSentWithQuota).toHaveBeenCalledTimes(3);
    expect(m.revertToPending).not.toHaveBeenCalled();
  });
});

describe('createDispatchWorker (factory)', () => {
  it('constructs a Worker on campaign.dispatch with concurrency=1, lockDuration=1min, own connection', () => {
    createDispatchWorker(CTX);

    expect(vi.mocked(createRedisClient)).toHaveBeenCalledWith('worker.campaign-dispatch');
    expect(workerConstructorCalls).toHaveLength(1);
    const call = workerConstructorCalls[0]!;
    expect(call.name).toBe(QUEUE_NAMES.campaign.dispatch);
    expect(call.opts.connection).toBe(fakeRedisClient);
    expect(call.opts.concurrency).toBe(1);
    expect(call.opts.lockDuration).toBe(60 * 1000);
  });
});
