/**
 * Unit tests for `handleCustomerStateChanged` (Epic F §F-9).
 *
 * Mocked-Prisma + mocked-queue + mocked-Shopify-helpers pattern.
 * Real repositories run end-to-end against the mocked Prisma delegates
 * (verifies the integration of payload → repo args → Prisma call shape
 * end-to-end, not just isolated handler control flow).
 *
 * The AI provider is NOT invoked by the handler (§F-9 step 10: "handler
 * does not wait for the LLM response"). Worker concerns live in Step 2c.
 *
 * Critical invariants this suite locks:
 *   - Type-guard narrows payload.newState to WinbackTriggerState before
 *     downstream usage; no `as` casts.
 *   - All bail conditions return WITHOUT creating AiGeneration / Message
 *     / queue job.
 *   - Spend-cap denial writes an `ai.spend_cap_exceeded` audit row and
 *     skips all other writes.
 *   - BigInt coercion at the rfmScore.mCents string → BigInt boundary
 *     (rule #19).
 *   - Cap unit conversion: cents × 100_000n → microcents before the
 *     comparison with `sumMonthSpend` output.
 *   - External HTTP (Shopify recent-orders) outside the tx with []
 *     fallback on failure.
 *   - BullMQ enqueue jobId = aiGenerationId (idempotent-replay contract).
 */

import { describe, expect, it, vi, type Mock } from 'vitest';

// Selective mock of @winback/shopify — replace buildAdminClient +
// fetchRecentOrders with controllable stubs; pass everything else
// through. The handler calls these two; mocking the others would
// risk drift if @winback/shopify's surface evolves.
vi.mock('@winback/shopify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@winback/shopify')>();
  return {
    ...actual,
    buildAdminClient: vi.fn(() => ({}) as unknown),
    fetchRecentOrders: vi.fn(async () => []),
  };
});

import { AUDIT_ACTIONS } from '@winback/contracts';
import type { OutboxEventRow, WinbackPrisma } from '@winback/db';
import type { Queues } from '@winback/queue';
import { fetchRecentOrders } from '@winback/shopify';
import type { ShopifyConfig } from '@winback/shopify';

import { handleCustomerStateChanged } from '../../src/handlers/customer-state-changed.js';
import type { DrainerContext } from '../../src/context.js';

// ---------------------------------------------------------------------------
// Mock plumbing
// ---------------------------------------------------------------------------

interface MockState {
  billing: { status: string } | null;
  merchant: { name: string | null; currency: string | null; shop: string } | null;
  settings: { monthlyAiSpendCapCents: bigint; aiTone: unknown } | null;
  customer: { firstName: string | null; lastName: string | null } | null;
  spendBucketSumMicrocents: bigint;
  aiGenerationRows: Array<{ id: string; data: Record<string, unknown> }>;
  messageRows: Array<{ id: string; data: Record<string, unknown> }>;
  auditLogRows: Array<{ data: Record<string, unknown> }>;
  queueAddCalls: Array<{ name: string; payload: unknown; opts: unknown }>;
  nextAiGenerationId: number;
  nextMessageId: number;
}

function makeCtx(initial: Partial<MockState> = {}): {
  ctx: DrainerContext;
  state: MockState;
  prismaMocks: {
    billingFindUnique: Mock;
    merchantFindUnique: Mock;
    merchantSettingsFindUnique: Mock;
    customerFindUnique: Mock;
    aiSpendBucketAggregate: Mock;
    aiGenerationCreate: Mock;
    messageCreate: Mock;
    auditLogCreate: Mock;
    transaction: Mock;
  };
  queueAdd: Mock;
} {
  // Use `in` checks for the nullable fields (billing/merchant/settings/
  // customer): `??` would collapse explicit-null overrides ({ customer:
  // null }) to the default, masking the null-bail tests.
  const state: MockState = {
    billing: 'billing' in initial ? initial.billing : { status: 'active' },
    merchant:
      'merchant' in initial
        ? initial.merchant
        : { name: 'Foo Store', currency: 'USD', shop: 'foo.myshopify.com' },
    settings:
      'settings' in initial
        ? initial.settings
        : { monthlyAiSpendCapCents: 50_000n, aiTone: null }, // $500/mo schema default
    customer:
      'customer' in initial
        ? initial.customer
        : { firstName: 'Alice', lastName: 'Doe' },
    spendBucketSumMicrocents: initial.spendBucketSumMicrocents ?? 0n,
    aiGenerationRows: [],
    messageRows: [],
    auditLogRows: [],
    queueAddCalls: [],
    nextAiGenerationId: 1,
    nextMessageId: 1,
  };

  const billingFindUnique = vi.fn(async () => state.billing);
  const merchantFindUnique = vi.fn(async () => state.merchant);
  const merchantSettingsFindUnique = vi.fn(async () => state.settings);
  const customerFindUnique = vi.fn(async () => state.customer);
  const aiSpendBucketAggregate = vi.fn(async () => ({
    _sum: { spentMicrocents: state.spendBucketSumMicrocents },
  }));
  const aiGenerationCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    const id = `gen_${String(state.nextAiGenerationId)}`;
    state.nextAiGenerationId += 1;
    state.aiGenerationRows.push({ id, data: args.data });
    return { id };
  });
  const messageCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    const id = `msg_${String(state.nextMessageId)}`;
    state.nextMessageId += 1;
    state.messageRows.push({ id, data: args.data });
    return { id };
  });
  const auditLogCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    state.auditLogRows.push({ data: args.data });
    return { id: 'audit_1' };
  });

  // $transaction(fn) — the inner fn receives the same prisma stub so the
  // tx-cast pattern in the handler is exercised end-to-end.
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    return fn(prisma);
  });

  const prisma = {
    billingSubscription: { findUnique: billingFindUnique },
    merchant: { findUnique: merchantFindUnique },
    merchantSettings: { findUnique: merchantSettingsFindUnique },
    customer: { findUnique: customerFindUnique },
    aiSpendBucket: { aggregate: aiSpendBucketAggregate },
    aiGeneration: { create: aiGenerationCreate },
    message: { create: messageCreate },
    auditLog: { create: auditLogCreate },
    $transaction: transaction,
  } as unknown as WinbackPrisma;

  const queueAdd = vi.fn(async (name: string, payload: unknown, opts: unknown) => {
    state.queueAddCalls.push({ name, payload, opts });
    return { id: 'queued' };
  });

  const queues = {
    outboxDrain: {} as never,
    cronRollup: {} as never,
    cronSweep: {} as never,
    aiGenerate: { add: queueAdd } as never,
  } as unknown as Queues;

  const shopifyConfig = {} as unknown as ShopifyConfig;

  const ctx: DrainerContext = { prisma, queues, shopifyConfig };

  return {
    ctx,
    state,
    prismaMocks: {
      billingFindUnique,
      merchantFindUnique,
      merchantSettingsFindUnique,
      customerFindUnique,
      aiSpendBucketAggregate,
      aiGenerationCreate,
      messageCreate,
      auditLogCreate,
      transaction,
    },
    queueAdd,
  };
}

function makeRow(overrides: {
  merchantId?: string;
  customerId?: string;
  oldState?: string;
  newState?: string;
  mCents?: string;
}): OutboxEventRow {
  return {
    id: 'evt_1',
    merchantId: overrides.merchantId ?? 'm_1',
    type: 'customer.state_changed',
    attempts: 0,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    payload: {
      merchantId: overrides.merchantId ?? 'm_1',
      customerId: overrides.customerId ?? 'c_1',
      shopifyCustomerId: 'gid://shopify/Customer/12345',
      oldState: overrides.oldState ?? 'active',
      newState: overrides.newState ?? 'at_risk',
      computedAt: '2026-06-01T00:00:00.000Z',
      rfmScore: {
        rDays: 45,
        fCount: 3,
        mCents: overrides.mCents ?? '12500',
        rQuintile: 2,
        fQuintile: 3,
        mQuintile: 3,
      },
    },
    // Other OutboxEventRow fields are not used by the handler.
  } as unknown as OutboxEventRow;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('handleCustomerStateChanged — happy path', () => {
  it('at_risk transition → creates AiGeneration + Message + enqueues ai.generate with jobId = aiGenerationId', async () => {
    const { ctx, state, queueAdd, prismaMocks } = makeCtx();
    const row = makeRow({ oldState: 'active', newState: 'at_risk' });

    await handleCustomerStateChanged(ctx, row);

    expect(state.aiGenerationRows).toHaveLength(1);
    expect(state.messageRows).toHaveLength(1);

    const aiGenData = state.aiGenerationRows[0]!.data;
    expect(aiGenData['merchantId']).toBe('m_1');
    expect(aiGenData['customerId']).toBe('c_1');
    expect(aiGenData['triggerState']).toBe('at_risk');
    expect(aiGenData['previousState']).toBe('active');
    expect(aiGenData['rDays']).toBe(45);
    expect(aiGenData['fCount']).toBe(3);
    expect(aiGenData['churnRiskScore']).toBeNull();
    expect(aiGenData['provider']).toBe('deepseek');
    expect(aiGenData['modelId']).toBe('deepseek-v4-flash');
    expect(typeof aiGenData['systemPrompt']).toBe('string');
    expect(typeof aiGenData['userPrompt']).toBe('string');
    expect((aiGenData['systemPrompt'] as string).length).toBeGreaterThan(0);
    expect((aiGenData['userPrompt'] as string).length).toBeGreaterThan(0);

    const msgData = state.messageRows[0]!.data;
    expect(msgData['merchantId']).toBe('m_1');
    expect(msgData['customerId']).toBe('c_1');
    expect(msgData['aiGenerationId']).toBe('gen_1');
    expect(msgData['generatedText']).toBe('');

    // Both writes inside ONE prisma.$transaction.
    expect(prismaMocks.transaction).toHaveBeenCalledTimes(1);

    // BullMQ enqueue with jobId = aiGenerationId (§F-8 idempotent replay).
    expect(queueAdd).toHaveBeenCalledTimes(1);
    const [name, payload, opts] = queueAdd.mock.calls[0] as unknown as [
      string,
      { aiGenerationId: string; merchantId: string; customerId: string },
      { jobId: string; attempts: number; backoff: { type: string; delay: number } },
    ];
    expect(name).toBe('generate');
    expect(payload).toEqual({
      aiGenerationId: 'gen_1',
      merchantId: 'm_1',
      customerId: 'c_1',
    });
    expect(opts.jobId).toBe('gen_1');
    expect(opts.attempts).toBe(3);
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 1000 });

    // Spend ceiling did NOT fire — no audit row written on happy path.
    expect(state.auditLogRows).toHaveLength(0);
  });

  it('coerces payload.rfmScore.mCents from string to BigInt at the boundary (rule #19)', async () => {
    const { ctx, state } = makeCtx();
    // Value > Number.MAX_SAFE_INTEGER to surface accidental Number cast.
    const big = '9007199254740997'; // 2^53 + 5
    const row = makeRow({ mCents: big });

    await handleCustomerStateChanged(ctx, row);

    const aiGenData = state.aiGenerationRows[0]!.data;
    expect(typeof aiGenData['mCents']).toBe('bigint');
    expect(aiGenData['mCents']).toBe(BigInt(big));
  });

  it('passes recentProducts from fetchRecentOrders into the prompt builder', async () => {
    const mockedFetch = vi.mocked(fetchRecentOrders);
    mockedFetch.mockResolvedValueOnce([
      { title: 'Sneakers' },
      { title: 'Hoodie' },
    ]);

    const { ctx, state } = makeCtx();
    const row = makeRow({});

    await handleCustomerStateChanged(ctx, row);

    // The prompt builder is a pure function called inside the handler;
    // verify its output (userPrompt) includes the product titles.
    const userPrompt = state.aiGenerationRows[0]!.data['userPrompt'] as string;
    expect(userPrompt).toContain('Sneakers');
    expect(userPrompt).toContain('Hoodie');
  });
});

// ---------------------------------------------------------------------------
// Bail conditions — newState gate (Step 2)
// ---------------------------------------------------------------------------

describe('handleCustomerStateChanged — newState gate (Step 2)', () => {
  it.each(['active', 'warm', 'insufficient_data'])(
    'newState=%s → bail; no writes, no enqueue',
    async (newState) => {
      const { ctx, state, queueAdd } = makeCtx();
      const row = makeRow({ oldState: 'at_risk', newState });

      await handleCustomerStateChanged(ctx, row);

      expect(state.aiGenerationRows).toHaveLength(0);
      expect(state.messageRows).toHaveLength(0);
      expect(state.auditLogRows).toHaveLength(0);
      expect(queueAdd).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// Bail conditions — oldState === newState defensive gate (Step 3)
// ---------------------------------------------------------------------------

describe('handleCustomerStateChanged — oldState === newState defensive gate', () => {
  it('bails when oldState === newState (defensive — producer also gates)', async () => {
    const { ctx, state, queueAdd, prismaMocks } = makeCtx();
    const row = makeRow({ oldState: 'at_risk', newState: 'at_risk' });

    await handleCustomerStateChanged(ctx, row);

    expect(state.aiGenerationRows).toHaveLength(0);
    expect(state.messageRows).toHaveLength(0);
    expect(queueAdd).not.toHaveBeenCalled();
    // Never reached DB at all — return is BEFORE withTenantScope.
    expect(prismaMocks.billingFindUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Bail conditions — BillingSubscription gate (Step 4)
// ---------------------------------------------------------------------------

describe('handleCustomerStateChanged — billing gate', () => {
  it.each(['past_due', 'cancelled', 'paused'])(
    'billing.status=%s → bail; no writes, no enqueue, no audit',
    async (status) => {
      const { ctx, state, queueAdd } = makeCtx({ billing: { status } });
      const row = makeRow({});

      await handleCustomerStateChanged(ctx, row);

      expect(state.aiGenerationRows).toHaveLength(0);
      expect(state.auditLogRows).toHaveLength(0);
      expect(queueAdd).not.toHaveBeenCalled();
    },
  );

  it('BillingSubscription row missing → bail', async () => {
    const { ctx, state, queueAdd } = makeCtx({ billing: null });
    const row = makeRow({});

    await handleCustomerStateChanged(ctx, row);

    expect(state.aiGenerationRows).toHaveLength(0);
    expect(queueAdd).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Spend ceiling (Step 5)
// ---------------------------------------------------------------------------

describe('handleCustomerStateChanged — spend ceiling check (Step 5)', () => {
  it('spend exceeded → audit row written, NO AiGeneration, NO enqueue', async () => {
    // Cap is 50_000 cents = 5_000_000_000 microcents. Set current
    // spend close enough that adding estimatedCallMicrocents pushes
    // the sum over.
    const { ctx, state, queueAdd, prismaMocks } = makeCtx({
      spendBucketSumMicrocents: 4_999_999_999n,
    });
    const row = makeRow({});

    await handleCustomerStateChanged(ctx, row);

    // No AiGeneration / Message / queue job.
    expect(state.aiGenerationRows).toHaveLength(0);
    expect(state.messageRows).toHaveLength(0);
    expect(queueAdd).not.toHaveBeenCalled();
    // tx never opened — the bail returns BEFORE the createPending tx.
    expect(prismaMocks.transaction).not.toHaveBeenCalled();

    // Audit row written with the correct action + structured context.
    expect(state.auditLogRows).toHaveLength(1);
    const audit = state.auditLogRows[0]!.data;
    expect(audit['action']).toBe(AUDIT_ACTIONS.ai.spend_cap_exceeded);
    expect(audit['actorType']).toBe('system');
    expect(audit['actorId']).toBe('drainer');
    expect(audit['merchantId']).toBe('m_1');
    expect(audit['shop']).toBe('foo.myshopify.com');
    expect(audit['targetType']).toBe('customer');
    expect(audit['targetId']).toBe('c_1');
    const context = audit['context'] as Record<string, unknown>;
    expect(context['currentSpendMicrocents']).toBe('4999999999');
    expect(context['capMicrocents']).toBe('5000000000'); // 50_000n × 100_000n
    expect(context['eventId']).toBe('evt_1');
    expect(typeof context['estimatedCallMicrocents']).toBe('string');
  });

  it('monthlyAiSpendCapCents=0n → every call denied with audit', async () => {
    const { ctx, state, queueAdd } = makeCtx({
      settings: { monthlyAiSpendCapCents: 0n, aiTone: null },
      spendBucketSumMicrocents: 0n, // no prior spend
    });
    const row = makeRow({});

    await handleCustomerStateChanged(ctx, row);

    // currentSpend (0n) + estimatedCallMicrocents (positive) > 0n → denied.
    expect(state.aiGenerationRows).toHaveLength(0);
    expect(queueAdd).not.toHaveBeenCalled();
    expect(state.auditLogRows).toHaveLength(1);
    expect(state.auditLogRows[0]!.data['action']).toBe(
      AUDIT_ACTIONS.ai.spend_cap_exceeded,
    );
  });

  it('currentSpend + estimatedCall === capMicrocents (boundary) → ALLOWED', async () => {
    // The check is strict `>`, not `>=`. Exactly at cap is allowed.
    // To hit the boundary deterministically we need to know
    // estimatedCallMicrocents at the test-time AI_PROVIDER+MODEL.
    // For deepseek-v4-flash + 500 input × 14/1M + 300 output × 28/1M:
    //   input  contribution = 500 * 14_000_000 / 1_000_000 = 7_000_000
    //                                                       microcents
    //   output contribution = 300 * 28_000_000 / 1_000_000 = 8_400_000
    //                                                       microcents
    //   total estimatedCallMicrocents = 15_400_000n
    //
    // Wait — that math is off. estimateCostMicrocents uses BigInt
    // arithmetic on inputPer1M = 14_000_000n microcents per 1M tokens.
    // For 500 tokens that's (500n * 14_000_000n) / 1_000_000n = 7_000n
    // microcents. Output: (300n * 28_000_000n) / 1_000_000n = 8_400n.
    // Total: 15_400n microcents.
    //
    // Set cap microcents to currentSpend + 15_400 exactly to hit the
    // boundary. We pick currentSpend = 1_000_000_000n (10 USD) and
    // cap = currentSpend + 15_400 = 1_000_015_400 microcents → cap cents
    // = 10_000.154 — NOT an integer. So instead pick currentSpend such
    // that the resulting cap-in-cents is an integer:
    //   capMicrocents = currentSpend + 15_400n
    //   capCents     = capMicrocents / 100_000n  (must be integer)
    // Choose capCents = 10_000n → capMicrocents = 1_000_000_000n →
    // currentSpend = 1_000_000_000n - 15_400n = 999_984_600n.
    const { ctx, state, queueAdd } = makeCtx({
      settings: { monthlyAiSpendCapCents: 10_000n, aiTone: null },
      spendBucketSumMicrocents: 999_984_600n,
    });
    const row = makeRow({});

    await handleCustomerStateChanged(ctx, row);

    // ALLOWED — no audit, full creation path runs.
    expect(state.auditLogRows).toHaveLength(0);
    expect(state.aiGenerationRows).toHaveLength(1);
    expect(queueAdd).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Customer not found (cascade race — Step 6a)
// ---------------------------------------------------------------------------

describe('handleCustomerStateChanged — customer cascade race', () => {
  it('customer not found (cascade race) → bail; no writes, no enqueue', async () => {
    const { ctx, state, queueAdd } = makeCtx({ customer: null });
    const row = makeRow({});

    await handleCustomerStateChanged(ctx, row);

    expect(state.aiGenerationRows).toHaveLength(0);
    expect(queueAdd).not.toHaveBeenCalled();
    // Spend ceiling passed (no audit) — we got past Step 5 before
    // bailing on Step 6a.
    expect(state.auditLogRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Shopify outage resilience (Step 6b)
// ---------------------------------------------------------------------------

describe('handleCustomerStateChanged — Shopify recent-orders outage', () => {
  it('fetchRecentOrders throws → handler continues with empty recentProducts', async () => {
    const mockedFetch = vi.mocked(fetchRecentOrders);
    mockedFetch.mockRejectedValueOnce(new Error('shopify timeout'));

    const { ctx, state, queueAdd } = makeCtx();
    const row = makeRow({});

    await handleCustomerStateChanged(ctx, row);

    // AiGeneration + Message + enqueue still happen.
    expect(state.aiGenerationRows).toHaveLength(1);
    expect(state.messageRows).toHaveLength(1);
    expect(queueAdd).toHaveBeenCalledTimes(1);

    // userPrompt does NOT include the "Their recent purchases included"
    // marker since recentProducts is empty.
    const userPrompt = state.aiGenerationRows[0]!.data['userPrompt'] as string;
    expect(userPrompt).not.toContain('recent purchases included');
  });
});
