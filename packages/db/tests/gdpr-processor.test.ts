/**
 * Unit tests for the C6 GDPR compliance processors.
 *
 * Mock-prisma pattern (records ops in-memory). Scope is CONTROL-FLOW
 * SHAPE ONLY — tenant-scope wrapping, audit-row sequencing,
 * malformed-payload bail, shop-redact chunked-delete loop, idempotency
 * on missing merchant. Fast feedback (~10 ms per test) for regressions
 * in those structural concerns.
 *
 * OUTCOME assertions (PII is actually absent from real rows after a
 * redact; child-table deletion happens; sentinel substitution writes
 * the right column shape) are owned by the real-Postgres integration
 * test at apps/drainer/tests/integration/gdpr.test.ts. That's where the
 * L4-H1 mock-mirrors-implementation anti-pattern is structurally closed
 * — outcomes are asserted against real DB state, not against the mock
 * faithfully recording the call the implementation just made.
 *
 * Role separation:
 *   - THIS FILE asserts: "did the handler write the right audit row?
 *     wrap in tenant scope? bail on malformed input? loop chunks N times
 *     for shop-redact?"
 *   - INTEGRATION FILE asserts: "after the handler ran, is the PII
 *     actually gone from every row in Postgres?"
 *
 * The tenantTables mock mirror below is RETAINED EXCLUSIVELY for
 * processShopRedact's chunk-loop tests — that flow operates on
 * tenant-wide deleteMany batches whose shape is faithfully simulated
 * here, and the chunk-iteration count is the assertion. The
 * processCustomerRedact tests in this file do NOT touch the
 * tenantTables mirror; their child-table delete behavior is verified
 * end-to-end by the integration test against real Postgres.
 */

import { describe, expect, it, vi } from 'vitest';

import type { WinbackPrisma } from '../src/client.js';
import {
  DEFAULT_SHOP_REDACT_BATCH_SIZE,
  processCustomerDataRequest,
  processCustomerRedact,
  processShopRedact,
} from '../src/compliance/gdpr-processor.js';

const MERCHANT_ID = 'm_test';
const SHOP = 'test-shop.myshopify.com';

// ===========================================================================
// Mock prisma — records operations and lets the test inspect state.
// ===========================================================================

interface MockCustomer {
  id: string;
  merchantId: string;
  shopifyCustomerId: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  deletedAt: Date | null;
}

interface AuditLogRow {
  merchantId: string | null;
  shop: string | null;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  context: unknown;
}

interface MockTenantTable {
  /** Number of rows for this merchant, used by the chunked-delete loop. */
  rows: string[];
}

interface MockState {
  merchant: { id: string; shop: string } | null;
  customers: MockCustomer[];
  orderCustomerIdUpdates: { merchantId: string; customerId: string }[];
  tenantTables: Record<string, MockTenantTable>;
  sessionDeleteCount: number;
  merchantDeleteCount: number;
  auditLogs: AuditLogRow[];
}

function makeInitialState(): MockState {
  return {
    merchant: null,
    customers: [],
    orderCustomerIdUpdates: [],
    // Mirrors SHOP_REDACT_TABLES_IN_ORDER — used ONLY by
    // processShopRedact's chunked-delete-loop tests below. The
    // processCustomerRedact tests do NOT consume this mirror; their
    // child-table deletion behavior is verified by the real-Postgres
    // integration test at apps/drainer/tests/integration/gdpr.test.ts
    // (B2 — closes L4-H1 structurally).
    tenantTables: {
      orderLineItem: { rows: [] },
      order: { rows: [] },
      message: { rows: [] },         // B1 addition
      aiGeneration: { rows: [] },    // B1 addition
      customerScore: { rows: [] },   // B1 addition
      productVariant: { rows: [] },
      product: { rows: [] },
      customer: { rows: [] },
      outboxEvent: { rows: [] },
      idempotencyKey: { rows: [] },
      backfillJob: { rows: [] },
      aiSpendBucket: { rows: [] },   // B1 addition
      merchantSettings: { rows: [] },
      billingSubscription: { rows: [] },
    },
    sessionDeleteCount: 0,
    merchantDeleteCount: 0,
    auditLogs: [],
  };
}

interface MockHandle {
  prisma: WinbackPrisma;
  state: MockState;
  callLog: string[];
}

function makeMockPrisma(initial?: Partial<MockState>): MockHandle {
  const state: MockState = { ...makeInitialState(), ...initial };
  const callLog: string[] = [];

  function buildTenantDelegate(table: string) {
    return {
      findMany: vi.fn(async (args: { where: { merchantId: string }; take: number }) => {
        callLog.push(`${table}.findMany take=${args.take}`);
        const t = state.tenantTables[table];
        if (t === undefined) throw new Error(`unexpected table: ${table}`);
        const batch = t.rows.slice(0, args.take);
        return batch.map((id) => ({ id }));
      }),
      deleteMany: vi.fn(async (args: { where: { merchantId: string; id?: { in: string[] } } }) => {
        callLog.push(`${table}.deleteMany`);
        const t = state.tenantTables[table];
        if (t === undefined) throw new Error(`unexpected table: ${table}`);
        if (args.where.id?.in !== undefined) {
          const ids = new Set(args.where.id.in);
          t.rows = t.rows.filter((r) => !ids.has(r));
        } else {
          t.rows = [];
        }
        return { count: 0 };
      }),
    };
  }

  function buildOneToOneDelegate(table: string) {
    return {
      deleteMany: vi.fn(async (_args: { where: { merchantId: string } }) => {
        callLog.push(`${table}.deleteMany`);
        const t = state.tenantTables[table];
        if (t !== undefined) t.rows = [];
        return { count: 0 };
      }),
    };
  }

  const customerDelegate = {
    findUnique: vi.fn(async (args: { where: { merchantId_shopifyCustomerId: { merchantId: string; shopifyCustomerId: string } } }) => {
      callLog.push('customer.findUnique');
      const key = args.where.merchantId_shopifyCustomerId;
      const found = state.customers.find(
        (c) => c.merchantId === key.merchantId && c.shopifyCustomerId === key.shopifyCustomerId,
      );
      return found ? { id: found.id } : null;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Partial<MockCustomer> }) => {
      callLog.push('customer.update');
      const c = state.customers.find((x) => x.id === args.where.id);
      if (c === undefined) throw new Error('mock: customer.update on missing row');
      Object.assign(c, args.data);
      return { ...c };
    }),
    findMany: buildTenantDelegate('customer').findMany,
    deleteMany: buildTenantDelegate('customer').deleteMany,
  };

  const orderDelegate = {
    updateMany: vi.fn(async (args: { where: { merchantId: string; customerId: string }; data: { customerId: null } }) => {
      callLog.push('order.updateMany');
      state.orderCustomerIdUpdates.push({
        merchantId: args.where.merchantId,
        customerId: args.where.customerId,
      });
      return { count: 0 };
    }),
    findMany: buildTenantDelegate('order').findMany,
    deleteMany: buildTenantDelegate('order').deleteMany,
  };

  const auditLogDelegate = {
    create: vi.fn(async (args: { data: AuditLogRow }) => {
      callLog.push(`auditLog.create action=${args.data.action}`);
      state.auditLogs.push(args.data);
      return args.data;
    }),
  };

  const idempotencyKeyDelegate = {
    findMany: vi.fn(async (args: { where: { merchantId: string }; take: number }) => {
      callLog.push(`idempotencyKey.findMany take=${args.take}`);
      const t = state.tenantTables.idempotencyKey;
      if (t === undefined) throw new Error('mock: idempotencyKey missing');
      const batch = t.rows.slice(0, args.take);
      return batch.map((key) => ({ key }));
    }),
    deleteMany: vi.fn(async (args: { where: { merchantId: string; key?: { in: string[] } } }) => {
      callLog.push('idempotencyKey.deleteMany');
      const t = state.tenantTables.idempotencyKey;
      if (t === undefined) throw new Error('mock: idempotencyKey missing');
      if (args.where.key?.in !== undefined) {
        const keys = new Set(args.where.key.in);
        t.rows = t.rows.filter((r) => !keys.has(r));
      } else {
        t.rows = [];
      }
      return { count: 0 };
    }),
  };

  const merchantDelegate = {
    findUnique: vi.fn(async (args: { where: { shop: string } }) => {
      callLog.push('merchant.findUnique');
      if (state.merchant?.shop === args.where.shop) {
        return { id: state.merchant.id };
      }
      return null;
    }),
    delete: vi.fn(async (args: { where: { id: string } }) => {
      callLog.push('merchant.delete');
      if (state.merchant?.id === args.where.id) {
        state.merchant = null;
      }
      state.merchantDeleteCount += 1;
      return { id: args.where.id };
    }),
  };

  const sessionDelegate = {
    deleteMany: vi.fn(async (args: { where: { shop: string } }) => {
      callLog.push(`session.deleteMany shop=${args.where.shop}`);
      state.sessionDeleteCount += 1;
      return { count: 0 };
    }),
  };

  const orderLineItem = {
    findMany: buildTenantDelegate('orderLineItem').findMany,
    deleteMany: buildTenantDelegate('orderLineItem').deleteMany,
  };
  const productVariant = {
    findMany: buildTenantDelegate('productVariant').findMany,
    deleteMany: buildTenantDelegate('productVariant').deleteMany,
  };
  const product = {
    findMany: buildTenantDelegate('product').findMany,
    deleteMany: buildTenantDelegate('product').deleteMany,
  };
  const outboxEvent = {
    findMany: buildTenantDelegate('outboxEvent').findMany,
    deleteMany: buildTenantDelegate('outboxEvent').deleteMany,
  };
  const backfillJob = {
    findMany: buildTenantDelegate('backfillJob').findMany,
    deleteMany: buildTenantDelegate('backfillJob').deleteMany,
  };
  // B1 additions — match SHOP_REDACT_TABLES_IN_ORDER. Standard
  // single-column-id tables; use the same buildTenantDelegate pattern as
  // their Epic D peers above.
  const message = {
    findMany: buildTenantDelegate('message').findMany,
    deleteMany: buildTenantDelegate('message').deleteMany,
  };
  const aiGeneration = {
    findMany: buildTenantDelegate('aiGeneration').findMany,
    deleteMany: buildTenantDelegate('aiGeneration').deleteMany,
  };
  const customerScore = {
    findMany: buildTenantDelegate('customerScore').findMany,
    deleteMany: buildTenantDelegate('customerScore').deleteMany,
  };
  const aiSpendBucket = {
    findMany: buildTenantDelegate('aiSpendBucket').findMany,
    deleteMany: buildTenantDelegate('aiSpendBucket').deleteMany,
  };
  const merchantSettings = buildOneToOneDelegate('merchantSettings');
  const billingSubscription = buildOneToOneDelegate('billingSubscription');

  const txClient = {
    auditLog: auditLogDelegate,
    customer: customerDelegate,
    order: orderDelegate,
    orderLineItem,
    message,
    aiGeneration,
    customerScore,
    productVariant,
    product,
    outboxEvent,
    idempotencyKey: idempotencyKeyDelegate,
    backfillJob,
    aiSpendBucket,
    merchantSettings,
    billingSubscription,
  };

  const prismaLike = {
    ...txClient,
    merchant: merchantDelegate,
    session: sessionDelegate,
    $transaction: vi.fn(async <T>(cb: (tx: typeof txClient) => Promise<T>) => cb(txClient)),
  };

  return {
    prisma: prismaLike as unknown as WinbackPrisma,
    state,
    callLog,
  };
}

// ===========================================================================
// processCustomerDataRequest
// ===========================================================================

describe('processCustomerDataRequest', () => {
  it('writes a gdpr.customer_data_request AuditLog row inside the tenant scope', async () => {
    const handle = makeMockPrisma();
    await processCustomerDataRequest({
      prisma: handle.prisma,
      merchantId: MERCHANT_ID,
      shop: SHOP,
      payload: {
        shop_id: 999,
        shop_domain: SHOP,
        customer: { id: 12345, email: 'jane@example.com' },
        orders_requested: [100, 101],
        data_request: { id: 555 },
      },
    });

    expect(handle.state.auditLogs).toHaveLength(1);
    const row = handle.state.auditLogs[0]!;
    expect(row.merchantId).toBe(MERCHANT_ID);
    expect(row.shop).toBe(SHOP);
    expect(row.actorType).toBe('system');
    expect(row.action).toBe('gdpr.customer_data_request');
    expect(row.targetType).toBe('customer');
    expect(row.targetId).toBe('12345');
    const ctx = row.context as { dataRequestId: string; ordersRequested: string[]; shopDomain: string };
    expect(ctx.dataRequestId).toBe('555');
    expect(ctx.shopDomain).toBe(SHOP);
    expect(ctx.ordersRequested).toEqual(['100', '101']);
  });
});

// ===========================================================================
// processCustomerRedact
// ===========================================================================

describe('processCustomerRedact (control-flow only — OUTCOMES owned by integration test)', () => {
  // The "happy path: nulls PII / replaces shopifyCustomerId with sentinel /
  // hard-deletes Customer-CASCADE children / severs Order / writes audit"
  // assertions live in apps/drainer/tests/integration/gdpr.test.ts where
  // the assertions are against real Postgres state. Anything the mock
  // could assert here ("customer.update was called with X") would mirror
  // the implementation, not the outcome — the L4-H1 anti-pattern the
  // integration test exists to replace.

  it('no-local-record: writes gdpr.customer_redact_no_local_record and does NOT update any customer', async () => {
    const handle = makeMockPrisma(); // empty customers
    await processCustomerRedact({
      prisma: handle.prisma,
      merchantId: MERCHANT_ID,
      shop: SHOP,
      payload: {
        shop_domain: SHOP,
        customer: { id: 99999 },
      },
    });

    expect(handle.state.customers).toEqual([]);
    expect(handle.state.orderCustomerIdUpdates).toEqual([]);
    expect(handle.state.auditLogs).toHaveLength(1);
    expect(handle.state.auditLogs[0]!.action).toBe('gdpr.customer_redact_no_local_record');
  });

  it('malformed payload (no customer.id): logs gdpr.customer_redact_malformed and exits', async () => {
    const handle = makeMockPrisma();
    await processCustomerRedact({
      prisma: handle.prisma,
      merchantId: MERCHANT_ID,
      shop: SHOP,
      payload: { shop_domain: SHOP }, // customer missing entirely
    });

    expect(handle.callLog.some((c) => c === 'customer.update')).toBe(false);
    expect(handle.state.auditLogs).toHaveLength(1);
    expect(handle.state.auditLogs[0]!.action).toBe('gdpr.customer_redact_malformed');
  });

  it('rejects non-numeric customer id (no silent passthrough) — logs malformed', async () => {
    const handle = makeMockPrisma();
    await processCustomerRedact({
      prisma: handle.prisma,
      merchantId: MERCHANT_ID,
      shop: SHOP,
      payload: { shop_domain: SHOP, customer: { id: 'abc-not-numeric' } },
    });

    expect(handle.state.auditLogs).toHaveLength(1);
    expect(handle.state.auditLogs[0]!.action).toBe('gdpr.customer_redact_malformed');
  });
});

// ===========================================================================
// processShopRedact
// ===========================================================================

describe('processShopRedact', () => {
  it('idempotent: no merchant row → logs gdpr.shop_redact_idempotent and exits', async () => {
    const handle = makeMockPrisma(); // merchant = null
    await processShopRedact({
      prisma: handle.prisma,
      shop: SHOP,
      payload: { shop_domain: SHOP, shop_id: 999 },
    });

    expect(handle.state.merchantDeleteCount).toBe(0);
    expect(handle.state.sessionDeleteCount).toBe(0);
    expect(handle.state.auditLogs).toHaveLength(1);
    const row = handle.state.auditLogs[0]!;
    expect(row.merchantId).toBeNull();
    expect(row.shop).toBe(SHOP);
    expect(row.action).toBe('gdpr.shop_redact_idempotent');
  });

  it('happy path: writes audit, runs chunked deletes, deletes session, deletes merchant', async () => {
    const handle = makeMockPrisma({
      merchant: { id: MERCHANT_ID, shop: SHOP },
      tenantTables: {
        orderLineItem: { rows: [] },
        order: { rows: ['o1', 'o2', 'o3'] },
        message: { rows: ['m1'] },             // B1
        aiGeneration: { rows: ['ag1'] },       // B1
        customerScore: { rows: ['cs1'] },      // B1
        productVariant: { rows: ['pv1'] },
        product: { rows: ['p1'] },
        customer: { rows: ['c1', 'c2'] },
        outboxEvent: { rows: ['ob1'] },
        idempotencyKey: { rows: ['k1'] },
        backfillJob: { rows: [] },
        aiSpendBucket: { rows: ['sb1'] },      // B1
        merchantSettings: { rows: ['ms1'] },
        billingSubscription: { rows: [] },
      },
    });

    await processShopRedact({
      prisma: handle.prisma,
      shop: SHOP,
      payload: { shop_domain: SHOP, shop_id: 999 },
      batchSize: 10,
    });

    // Audit row written FIRST (before any tenant-table delete).
    const auditIndex = handle.callLog.indexOf('auditLog.create action=gdpr.shop_redact');
    const firstDeleteIndex = handle.callLog.findIndex((c) => c.endsWith('.deleteMany'));
    expect(auditIndex).toBeGreaterThanOrEqual(0);
    expect(firstDeleteIndex).toBeGreaterThan(auditIndex);

    // All tenant tables drained.
    for (const t of Object.keys(handle.state.tenantTables)) {
      expect(handle.state.tenantTables[t]!.rows).toEqual([]);
    }

    // Session + Merchant deleted exactly once.
    expect(handle.state.sessionDeleteCount).toBe(1);
    expect(handle.state.merchantDeleteCount).toBe(1);
    expect(handle.state.merchant).toBeNull();
  });

  it('chunks repeatedly when a table has more rows than batchSize', async () => {
    // 25 customers, batchSize 10 → 3 fetch-delete iterations (10, 10, 5)
    const handle = makeMockPrisma({
      merchant: { id: MERCHANT_ID, shop: SHOP },
      tenantTables: {
        ...makeInitialState().tenantTables,
        customer: {
          rows: Array.from({ length: 25 }, (_, i) => `c${String(i)}`),
        },
      },
    });

    await processShopRedact({
      prisma: handle.prisma,
      shop: SHOP,
      payload: { shop_domain: SHOP },
      batchSize: 10,
    });

    const customerFetches = handle.callLog.filter((c) => c.startsWith('customer.findMany'));
    // 3 successful fetches (10/10/5) — and at least one more to see "empty"
    // and terminate. The loop terminates when fetch returns fewer than
    // batchSize, so 3 fetches total.
    expect(customerFetches.length).toBe(3);
    expect(handle.state.tenantTables.customer!.rows).toEqual([]);
  });

  it('DEFAULT_SHOP_REDACT_BATCH_SIZE has a sensible value', () => {
    expect(DEFAULT_SHOP_REDACT_BATCH_SIZE).toBe(1000);
  });
});
