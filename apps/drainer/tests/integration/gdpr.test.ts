/**
 * B2 — real-Postgres GDPR redact integration tests (closes L3-H1, L4-H1
 * structural fix, L4-M3 invariant).
 *
 * Anti-mock-mirror discipline: PII is SEEDED through the production
 * pipeline. `handleCustomerStateChanged` runs `buildWinbackPrompt` with
 * the seeded Customer's firstName, so AiGeneration.systemPrompt and
 * AiGeneration.userPrompt contain the firstName verbatim. The (mocked
 * provider's) `generatedText` likewise contains the firstName, and the
 * AI worker persists it to both AiGeneration.generatedText and
 * Message.generatedText. THEN the test runs `processCustomerRedact` and
 * asserts the OUTCOME on real Postgres rows:
 *
 *   - the PII strings (firstName, lastName, email, phone) AND the
 *     original Shopify GID are absent from every customer-touching
 *     business table (L3-H1 closure proof);
 *   - the Customer row survives soft-deleted; its 4 PII columns are
 *     null and `shopifyCustomerId` is the redaction sentinel
 *     `redacted:<customer.id>` (un-attributable from the GID alone);
 *   - the 3 Customer-CASCADE child rows (CustomerScore, AiGeneration,
 *     Message) are hard-deleted;
 *   - Order rows survive with `customerId = null` (anonymous revenue
 *     history preserved);
 *   - AiSpendBucket is untouched (platform accounting has no Customer
 *     FK by design);
 *   - the cross-tenant guard: the same Shopify GID at two merchants
 *     produces two distinct Customer rows; redacting one MUST NOT
 *     touch the other.
 *
 * AuditLog is intentionally NOT scanned for PII strings. The
 * `gdpr.customer_redact` audit row's `context.shopifyCustomerGid`
 * field deliberately retains the original GID as GDPR-required
 * compliance evidence; scanning AuditLog would produce false-positive
 * leak reports against a forensic record we're contractually obliged
 * to keep.
 */

import { describe, it, expect, vi, beforeEach, afterAll, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must hoist above the static imports below.
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
    fetchRecentOrders: vi.fn(async () => []),
  };
});

// ---------------------------------------------------------------------------
// Imports — AFTER mocks.
// ---------------------------------------------------------------------------

import {
  type AiGenerateArgs,
  type AiGenerateResult,
  selectActiveProvider,
} from '@winback/ai';
import { AUDIT_ACTIONS } from '@winback/contracts';
import {
  CUSTOMER_REDACT_CHILD_TABLES,
  REDACTED_GID_SENTINEL_PREFIX,
  type OutboxEventRow,
  processCustomerRedact,
  withSystemScope,
} from '@winback/db';
import {
  assertRead,
  createTestMerchant,
  getTestClient,
  resetDb,
} from '@winback/db/test-utils';
import type { Queues } from '@winback/queue';
import type { ShopifyConfig } from '@winback/shopify';
import type { Job } from 'bullmq';

import type { DrainerContext } from '../../src/context.js';
import { handleCustomerStateChanged } from '../../src/handlers/customer-state-changed.js';
import {
  type AiGenerateJobPayload,
  processAiGenerateJob,
} from '../../src/workers/ai-generate.worker.js';

// ---------------------------------------------------------------------------
// PII fixture strings — deliberately distinct so a leaky row surfaces
// unambiguously in the assertPiiAbsent failure message.
// ---------------------------------------------------------------------------

const PII = {
  FIRST_NAME: 'Alice',
  LAST_NAME: 'Smith',
  EMAIL: 'alice@example.com',
  PHONE: '+15555550101',
} as const;

const ORIGINAL_GID_NUMERIC = '12345';
const ORIGINAL_GID = `gid://shopify/Customer/${ORIGINAL_GID_NUMERIC}`;

const SHOP_A = 'b2-gdpr-a.myshopify.com';
const SHOP_B = 'b2-gdpr-b.myshopify.com';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeDrainerCtx(): { ctx: DrainerContext; queueAdd: Mock } {
  const queueAdd = vi.fn(
    async (_jobName: string, _payload: unknown, _opts: unknown) => ({
      id: 'fake-job-id',
    }),
  );

  const ctx: DrainerContext = {
    prisma: getTestClient(),
    queues: {
      aiGenerate: { add: queueAdd } as never,
      outboxDrain: {} as never,
      cronRollup: {} as never,
      cronSweep: {} as never,
    },
    shopifyConfig: {} as unknown as ShopifyConfig,
  };

  return { ctx, queueAdd };
}

function setProviderGenerate(content: string): Mock {
  const generate = vi.fn(
    async (_args: AiGenerateArgs): Promise<AiGenerateResult> => ({
      content,
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      latencyMs: 100,
    }),
  );
  vi.mocked(selectActiveProvider).mockReturnValue({
    name: 'deepseek',
    generate,
  } as never);
  return generate;
}

/**
 * Seed a Customer row carrying PII (firstName/lastName/email/phone) at the
 * given merchant + Shopify GID. Returns the local Customer.id.
 */
async function seedCustomerWithPii(
  merchantId: string,
  shopifyCustomerId: string,
): Promise<string> {
  return withSystemScope('test.seed_customer_with_pii', async () => {
    const c = await getTestClient().customer.create({
      data: {
        merchantId,
        shopifyCustomerId,
        firstName: PII.FIRST_NAME,
        lastName: PII.LAST_NAME,
        email: PII.EMAIL,
        phone: PII.PHONE,
      },
      select: { id: true },
    });
    return c.id;
  });
}

function makeStateChangedRow(args: {
  merchantId: string;
  customerId: string;
  shopifyCustomerId: string;
}): OutboxEventRow {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 10)}`,
    merchantId: args.merchantId,
    type: 'customer.state_changed',
    payload: {
      merchantId: args.merchantId,
      customerId: args.customerId,
      shopifyCustomerId: args.shopifyCustomerId,
      oldState: 'active',
      newState: 'at_risk',
      computedAt: new Date().toISOString(),
      rfmScore: {
        rDays: 45,
        fCount: 3,
        mCents: '12500',
        rQuintile: 2,
        fQuintile: 3,
        mQuintile: 3,
      },
    },
    attempts: 0,
    createdAt: new Date(),
  } as unknown as OutboxEventRow;
}

async function runWorkerForPayload(
  ctx: DrainerContext,
  payload: AiGenerateJobPayload,
): Promise<void> {
  const job = {
    id: payload.aiGenerationId,
    data: payload,
    attemptsMade: 0,
  } as unknown as Job<AiGenerateJobPayload>;
  await processAiGenerateJob(ctx, job);
}

/**
 * Drive the full production pipeline for one customer at one merchant:
 * seed Customer with PII → handleCustomerStateChanged builds the prompt
 * (firstName embedded in systemPrompt + userPrompt) → AI worker writes
 * generatedText (also containing firstName) to AiGeneration + Message.
 * Side effect: an AiSpendBucket row exists for the merchant after this.
 */
async function seedFullPipeline(
  ctx: DrainerContext,
  queueAdd: Mock,
  merchantId: string,
  shopifyCustomerId: string,
): Promise<{ customerId: string; generatedText: string }> {
  const customerId = await seedCustomerWithPii(merchantId, shopifyCustomerId);
  const generatedText = `Hey ${PII.FIRST_NAME}, we miss you — come back!`;
  setProviderGenerate(generatedText);

  await handleCustomerStateChanged(
    ctx,
    makeStateChangedRow({ merchantId, customerId, shopifyCustomerId }),
  );

  // Capture the last queue add (each seed call appends one).
  const calls = queueAdd.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const lastCall = calls[calls.length - 1]!;
  const payload = lastCall[1] as AiGenerateJobPayload;
  await runWorkerForPayload(ctx, payload);

  return { customerId, generatedText };
}

/**
 * Iterate Customer / AiGeneration / Message and assert no row contains
 * the given needle in any text-bearing column scoped to the merchant.
 * AuditLog is intentionally NOT scanned — see file header.
 */
async function assertPiiAbsent(
  merchantId: string,
  needles: readonly string[],
): Promise<void> {
  for (const needle of needles) {
    const customers = await assertRead(() =>
      getTestClient().customer.findMany({
        where: {
          merchantId,
          OR: [
            { email: { contains: needle } },
            { phone: { contains: needle } },
            { firstName: { contains: needle } },
            { lastName: { contains: needle } },
            { shopifyCustomerId: { contains: needle } },
          ],
        },
      }),
    );
    expect(
      customers,
      `PII "${needle}" survived in Customer (merchant ${merchantId})`,
    ).toEqual([]);

    const aiGens = await assertRead(() =>
      getTestClient().aiGeneration.findMany({
        where: {
          merchantId,
          OR: [
            { systemPrompt: { contains: needle } },
            { userPrompt: { contains: needle } },
            { generatedText: { contains: needle } },
          ],
        },
      }),
    );
    expect(
      aiGens,
      `PII "${needle}" survived in AiGeneration (merchant ${merchantId})`,
    ).toEqual([]);

    const messages = await assertRead(() =>
      getTestClient().message.findMany({
        where: {
          merchantId,
          generatedText: { contains: needle },
        },
      }),
    );
    expect(
      messages,
      `PII "${needle}" survived in Message (merchant ${merchantId})`,
    ).toEqual([]);
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('B2 GDPR processCustomerRedact (real Postgres, mocked LLM + Shopify)', () => {
  beforeEach(async () => {
    await resetDb();
    vi.mocked(selectActiveProvider).mockReset();
  });

  afterAll(async () => {
    await getTestClient().$disconnect();
  });

  // -------------------------------------------------------------------------
  // SCENARIO 1 — L3-H1 closure: PII strings absent from every business table
  // -------------------------------------------------------------------------

  it('1. L3-H1 closure: PII strings + original GID absent from every customer-touching business table after redact', async () => {
    const merchantId = await createTestMerchant(SHOP_A);
    const { ctx, queueAdd } = makeDrainerCtx();
    await seedFullPipeline(ctx, queueAdd, merchantId, ORIGINAL_GID);

    // Pre-state sanity — the assertion isn't vacuous: PII IS present pre-redact.
    const preAiGens = await assertRead(() =>
      getTestClient().aiGeneration.findMany({ where: { merchantId } }),
    );
    expect(preAiGens, 'AiGeneration must be seeded by handler+worker').toHaveLength(1);
    expect(
      preAiGens[0]!.userPrompt,
      'firstName must reach AiGeneration.userPrompt via prompt-builder',
    ).toContain(PII.FIRST_NAME);
    expect(preAiGens[0]!.generatedText).toContain(PII.FIRST_NAME);

    const preMessages = await assertRead(() =>
      getTestClient().message.findMany({ where: { merchantId } }),
    );
    expect(preMessages, 'Message must be seeded by worker').toHaveLength(1);
    expect(preMessages[0]!.generatedText).toContain(PII.FIRST_NAME);

    // ── REDACT ──────────────────────────────────────────────────────────
    await processCustomerRedact({
      prisma: getTestClient(),
      merchantId,
      shop: SHOP_A,
      payload: {
        shop_domain: SHOP_A,
        customer: { id: Number(ORIGINAL_GID_NUMERIC) },
      },
    });

    // ── L3-H1 closure proof ─────────────────────────────────────────────
    await assertPiiAbsent(merchantId, [
      PII.FIRST_NAME,
      PII.LAST_NAME,
      PII.EMAIL,
      PII.PHONE,
      ORIGINAL_GID,
    ]);
  });

  // -------------------------------------------------------------------------
  // SCENARIO 2 — Cascade-correctness: Customer survives, 3 children gone,
  //              Order survives customerId-null, AiSpendBucket survives.
  // -------------------------------------------------------------------------

  it('2. Cascade-correctness: Customer survives soft-deleted with sentinel; 3 child rows hard-deleted; Order survives customerId-null; AiSpendBucket untouched', async () => {
    const merchantId = await createTestMerchant(SHOP_A);
    const { ctx, queueAdd } = makeDrainerCtx();
    const { customerId } = await seedFullPipeline(ctx, queueAdd, merchantId, ORIGINAL_GID);

    // Seed a CustomerScore explicitly so the customerScore branch of the
    // CUSTOMER_REDACT_CHILD_TABLES loop has a row to delete (the handler
    // pipeline doesn't auto-create one). `computedAt` is required (no
    // @default in the schema; Epic E session 2's scoring service writes it
    // explicitly on every recompute).
    await withSystemScope('test.seed_score', async () => {
      await getTestClient().customerScore.create({
        data: {
          merchantId,
          customerId,
          rDays: 45,
          fCount: 3,
          mCents: 12500n,
          currency: 'USD',
          computedAt: new Date(),
        },
      });
    });

    // Seed an Order so the Order-sever branch has a row to update.
    await withSystemScope('test.seed_order', async () => {
      await getTestClient().order.create({
        data: {
          merchantId,
          customerId,
          shopifyOrderId: 'gid://shopify/Order/9001',
          totalAmountCents: 5000n,
          subtotalAmountCents: 4500n,
          currency: 'USD',
          placedAt: new Date(),
        },
      });
    });

    const preBuckets = await assertRead(() =>
      getTestClient().aiSpendBucket.findMany({ where: { merchantId } }),
    );
    expect(preBuckets).toHaveLength(1);
    const preBucketSpend = preBuckets[0]!.spentMicrocents;
    const preBucketCount = preBuckets[0]!.generationCount;

    // ── REDACT ──────────────────────────────────────────────────────────
    await processCustomerRedact({
      prisma: getTestClient(),
      merchantId,
      shop: SHOP_A,
      payload: {
        shop_domain: SHOP_A,
        customer: { id: Number(ORIGINAL_GID_NUMERIC) },
      },
    });

    // ── 3 child rows hard-deleted ───────────────────────────────────────
    for (const table of CUSTOMER_REDACT_CHILD_TABLES) {
      const remaining = await assertRead(async () => {
        const client = getTestClient() as unknown as Record<
          string,
          { count: (a: unknown) => Promise<number> }
        >;
        return client[table]!.count({ where: { merchantId } });
      });
      expect(
        remaining,
        `${table} rows should be hard-deleted by redact (table from CUSTOMER_REDACT_CHILD_TABLES)`,
      ).toBe(0);
    }

    // ── Customer survives soft-deleted with sentinel ────────────────────
    // System-scope wraps the read for tenant-scope assertion, BUT the
    // soft-delete filter (hooks.ts:250) runs unconditionally after the
    // tenant check. The bypass on line 253 is "if `deletedAt` is in
    // WHERE, return args unchanged" — so explicitly filtering for
    // `deletedAt: { not: null }` both bypasses the auto-filter AND
    // structurally asserts the row IS soft-deleted (returns null if not,
    // which would surface a redact regression).
    const postCustomer = await withSystemScope('test.read_redacted_customer', async () =>
      getTestClient().customer.findFirst({
        where: { id: customerId, deletedAt: { not: null } },
      }),
    );
    expect(postCustomer, 'Customer should survive soft-deleted').not.toBeNull();
    expect(postCustomer!.email).toBeNull();
    expect(postCustomer!.phone).toBeNull();
    expect(postCustomer!.firstName).toBeNull();
    expect(postCustomer!.lastName).toBeNull();
    expect(postCustomer!.deletedAt).toBeInstanceOf(Date);
    expect(
      postCustomer!.shopifyCustomerId.startsWith(REDACTED_GID_SENTINEL_PREFIX),
      'shopifyCustomerId should be the redaction sentinel',
    ).toBe(true);
    expect(
      postCustomer!.shopifyCustomerId,
      'shopifyCustomerId MUST NOT be the original GID',
    ).not.toBe(ORIGINAL_GID);
    expect(
      postCustomer!.shopifyCustomerId,
      'sentinel format = `redacted:<customer.id>` (reused cuid PK, deterministic)',
    ).toBe(`${REDACTED_GID_SENTINEL_PREFIX}${customerId}`);

    // ── Order survives customerId-null ──────────────────────────────────
    const postOrders = await assertRead(() =>
      getTestClient().order.findMany({ where: { merchantId } }),
    );
    expect(postOrders, 'Order should survive').toHaveLength(1);
    expect(
      postOrders[0]!.customerId,
      'Order.customerId should be severed (null)',
    ).toBeNull();
    expect(
      postOrders[0]!.totalAmountCents,
      'Order revenue history preserved',
    ).toBe(5000n);

    // ── AiSpendBucket survives untouched ────────────────────────────────
    const postBuckets = await assertRead(() =>
      getTestClient().aiSpendBucket.findMany({ where: { merchantId } }),
    );
    expect(
      postBuckets,
      'AiSpendBucket should survive (no Customer FK; platform accounting)',
    ).toHaveLength(1);
    expect(postBuckets[0]!.spentMicrocents).toBe(preBucketSpend);
    expect(postBuckets[0]!.generationCount).toBe(preBucketCount);
  });

  // -------------------------------------------------------------------------
  // SCENARIO 3 — No cross-tenant bleed: same GID at two merchants
  // -------------------------------------------------------------------------

  it('3. No-cross-tenant-bleed: same Shopify GID at two merchants — redact at A leaves B fully intact (merchantId scope is the guard)', async () => {
    const merchantA = await createTestMerchant(SHOP_A);
    const merchantB = await createTestMerchant(SHOP_B);
    const { ctx, queueAdd } = makeDrainerCtx();

    // Same ORIGINAL_GID at both merchants.
    const { customerId: customerAId } = await seedFullPipeline(
      ctx,
      queueAdd,
      merchantA,
      ORIGINAL_GID,
    );
    const { customerId: customerBId } = await seedFullPipeline(
      ctx,
      queueAdd,
      merchantB,
      ORIGINAL_GID,
    );

    // Distinct local PKs (cuid) despite identical GID — composite unique
    // (merchantId, shopifyCustomerId) is the namespace boundary.
    expect(customerAId).not.toBe(customerBId);

    const preA = await assertRead(() =>
      getTestClient().aiGeneration.count({ where: { merchantId: merchantA } }),
    );
    const preB = await assertRead(() =>
      getTestClient().aiGeneration.count({ where: { merchantId: merchantB } }),
    );
    expect(preA).toBe(1);
    expect(preB).toBe(1);

    // ── REDACT MERCHANT A ONLY ──────────────────────────────────────────
    await processCustomerRedact({
      prisma: getTestClient(),
      merchantId: merchantA,
      shop: SHOP_A,
      payload: {
        shop_domain: SHOP_A,
        customer: { id: Number(ORIGINAL_GID_NUMERIC) },
      },
    });

    // ── Merchant A is redacted ──────────────────────────────────────────
    for (const table of CUSTOMER_REDACT_CHILD_TABLES) {
      const aCount = await assertRead(async () => {
        const client = getTestClient() as unknown as Record<
          string,
          { count: (a: unknown) => Promise<number> }
        >;
        return client[table]!.count({ where: { merchantId: merchantA } });
      });
      expect(
        aCount,
        `Merchant A's ${table} should be hard-deleted`,
      ).toBe(0);
    }

    // ── Merchant B is COMPLETELY UNTOUCHED ──────────────────────────────
    for (const table of CUSTOMER_REDACT_CHILD_TABLES) {
      const bCount = await assertRead(async () => {
        const client = getTestClient() as unknown as Record<
          string,
          { count: (a: unknown) => Promise<number> }
        >;
        return client[table]!.count({ where: { merchantId: merchantB } });
      });
      // Note: customerScore isn't auto-created by the pipeline; only message
      // and aiGeneration end up populated. Expect 1 for those two, 0 for
      // customerScore — the cross-tenant guard test is about "did A's redact
      // affect B's rows", not about "did B have a row".
      const expected = table === 'customerScore' ? 0 : 1;
      expect(
        bCount,
        `Merchant B's ${table} should NOT be touched by merchant A's redact (cross-tenant guard)`,
      ).toBe(expected);
    }

    // Merchant B's Customer has the original GID + PII intact.
    const bCustomer = await withSystemScope('test.read_b_customer', async () =>
      getTestClient().customer.findUnique({ where: { id: customerBId } }),
    );
    expect(bCustomer, 'Merchant B Customer should exist').not.toBeNull();
    expect(bCustomer!.firstName).toBe(PII.FIRST_NAME);
    expect(bCustomer!.lastName).toBe(PII.LAST_NAME);
    expect(bCustomer!.email).toBe(PII.EMAIL);
    expect(bCustomer!.phone).toBe(PII.PHONE);
    expect(bCustomer!.shopifyCustomerId).toBe(ORIGINAL_GID);
    expect(bCustomer!.deletedAt).toBeNull();

    // Merchant B's AiGeneration still has PII in the prompts.
    const bAiGens = await assertRead(() =>
      getTestClient().aiGeneration.findMany({ where: { merchantId: merchantB } }),
    );
    expect(bAiGens).toHaveLength(1);
    expect(bAiGens[0]!.userPrompt).toContain(PII.FIRST_NAME);
  });

  // -------------------------------------------------------------------------
  // SCENARIO 4 — L4-M3 deletedAt-preservation under duplicate delivery.
  //              Under Option D, delivery 2 hits no_local_record (the GID
  //              was rewritten to the sentinel) and does NOT update the
  //              Customer row. The conditional-set in processCustomerRedact
  //              is still the structural guarantee for any path where the
  //              row IS found with deletedAt already set; we prove the
  //              behavior via the GID rewrite path.
  // -------------------------------------------------------------------------

  it('4. L4-M3: duplicate redact delivery does NOT bump Customer.deletedAt (conditional-set invariant)', async () => {
    const merchantId = await createTestMerchant(SHOP_A);
    const { ctx, queueAdd } = makeDrainerCtx();
    const { customerId } = await seedFullPipeline(ctx, queueAdd, merchantId, ORIGINAL_GID);

    // Delivery 1 — Customer row is found, soft-deleted, sentinel substituted.
    await processCustomerRedact({
      prisma: getTestClient(),
      merchantId,
      shop: SHOP_A,
      payload: {
        shop_domain: SHOP_A,
        customer: { id: Number(ORIGINAL_GID_NUMERIC) },
      },
    });

    // The row is now soft-deleted. The Prisma extension's soft-delete
    // filter (hooks.ts:250) runs after the system-scope check and ALWAYS
    // hides `deletedAt: not null` rows from a bare `findUnique`. Include
    // `deletedAt` in the WHERE clause to take the explicit-deletedAt
    // bypass on hooks.ts:253; filter for `{ not: null }` so we
    // structurally assert the row IS soft-deleted (regression-catching).
    const after1 = await withSystemScope('test.read_after_delivery1', async () =>
      getTestClient().customer.findFirst({
        where: { id: customerId, deletedAt: { not: null } },
      }),
    );
    expect(after1, 'Customer should be present + soft-deleted after delivery 1').not.toBeNull();
    const deletedAt1 = after1!.deletedAt;
    expect(deletedAt1).toBeInstanceOf(Date);

    // Wait a tick so any spurious "new Date()" on delivery 2 would be
    // observable as a later timestamp.
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Delivery 2 — lookup by ORIGINAL_GID hits the sentinel, returns null →
    // no_local_record path. The Customer row is NEVER touched.
    await processCustomerRedact({
      prisma: getTestClient(),
      merchantId,
      shop: SHOP_A,
      payload: {
        shop_domain: SHOP_A,
        customer: { id: Number(ORIGINAL_GID_NUMERIC) },
      },
    });

    // Structural confirmation that delivery 2 actually took the
    // no_local_record path (and therefore could not have updated the
    // Customer row): exactly one no_local_record audit row exists for
    // this merchant after delivery 2. Without this assertion, "deletedAt
    // unchanged" could hold for the wrong reason (e.g. delivery 2 silently
    // no-op'd via some other branch).
    const noRecordAudits = await assertRead(() =>
      getTestClient().auditLog.findMany({
        where: {
          merchantId,
          action: AUDIT_ACTIONS.gdpr.customer_redact_no_local_record,
        },
      }),
    );
    expect(noRecordAudits, 'delivery 2 should have taken the no_local_record path').toHaveLength(1);

    const after2 = await withSystemScope('test.read_after_delivery2', async () =>
      getTestClient().customer.findFirst({
        where: { id: customerId, deletedAt: { not: null } },
      }),
    );
    expect(after2, 'Customer should still be present + soft-deleted after delivery 2').not.toBeNull();
    expect(
      after2!.deletedAt,
      'deletedAt MUST NOT be bumped by a duplicate redact delivery (L4-M3 invariant — delivery 2 took the no_local_record path, so the row was never updated)',
    ).toEqual(deletedAt1);
  });

  // -------------------------------------------------------------------------
  // SCENARIO 5 — Idempotency: duplicate delivery does not throw + records audit
  // -------------------------------------------------------------------------

  it('5. Idempotency: duplicate redact delivery does not throw and writes the no_local_record audit with the original GID preserved in context', async () => {
    const merchantId = await createTestMerchant(SHOP_A);
    const { ctx, queueAdd } = makeDrainerCtx();
    await seedFullPipeline(ctx, queueAdd, merchantId, ORIGINAL_GID);

    const redactArgs = {
      prisma: getTestClient(),
      merchantId,
      shop: SHOP_A,
      payload: {
        shop_domain: SHOP_A,
        customer: { id: Number(ORIGINAL_GID_NUMERIC) },
      },
    };

    // Delivery 1.
    await processCustomerRedact(redactArgs);

    // Delivery 2 — must not throw.
    await expect(
      processCustomerRedact(redactArgs),
      'duplicate redact should not throw',
    ).resolves.toBeUndefined();

    // Exactly one no_local_record audit (the duplicate). The first
    // delivery wrote a `gdpr.customer_redact` audit instead.
    const noRecordAudits = await assertRead(() =>
      getTestClient().auditLog.findMany({
        where: {
          merchantId,
          action: AUDIT_ACTIONS.gdpr.customer_redact_no_local_record,
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(noRecordAudits, 'duplicate delivery should record no_local_record audit').toHaveLength(1);
    const noRecordCtx = noRecordAudits[0]!.context as { shopifyCustomerGid: string };
    expect(
      noRecordCtx.shopifyCustomerGid,
      'no_local_record audit preserves queried GID for operator forensics (distinguishes duplicate-after-redact from never-ingested)',
    ).toBe(ORIGINAL_GID);

    // Cross-check: a single successful `customer_redact` audit from delivery 1.
    const successAudits = await assertRead(() =>
      getTestClient().auditLog.findMany({
        where: {
          merchantId,
          action: AUDIT_ACTIONS.gdpr.customer_redact,
        },
      }),
    );
    expect(successAudits).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // SCENARIO 6 — Never-ingested customer: no-local-record + no errors
  // -------------------------------------------------------------------------

  it('6. Never-ingested customer: writes no_local_record audit, does NOT create / update any Customer row', async () => {
    const merchantId = await createTestMerchant(SHOP_A);

    await processCustomerRedact({
      prisma: getTestClient(),
      merchantId,
      shop: SHOP_A,
      payload: { shop_domain: SHOP_A, customer: { id: 99999 } },
    });

    const customers = await assertRead(() =>
      getTestClient().customer.findMany({ where: { merchantId } }),
    );
    expect(customers, 'no Customer should be created').toHaveLength(0);

    const audits = await assertRead(() =>
      getTestClient().auditLog.findMany({
        where: {
          merchantId,
          action: AUDIT_ACTIONS.gdpr.customer_redact_no_local_record,
        },
      }),
    );
    expect(audits, 'no_local_record audit should be written').toHaveLength(1);
  });
});
