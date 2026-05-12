/**
 * Unit tests for backfill runner + customer-backfill helpers.
 *
 * The BackfillRunner orchestration tests use a minimal mock prisma
 * (records ops in-memory) so the loop logic — fetcher invocation,
 * processor invocation, cursor commit, hasNextPage check, error
 * classification — is genuinely exercised. The exhaustive integration
 * check (real Postgres, real durability after restart) lands in M10.
 */
import { BACKFILL_RESOURCES } from '@winback/contracts';
import { withTenantScope } from '@winback/db';
import { describe, expect, it, vi } from 'vitest';

import { ShopifyTokenRevokedError } from '../src/admin/errors.js';
import { BackfillRunner } from '../src/backfill/runner.js';
import {
  CustomerPageFetcher,
  extractNumericIdFromGid,
  parseDateOrNull,
  parseGid,
  parseIntOrZero,
  toCustomerGid,
  type ShopifyCustomerNode,
} from '../src/backfill/customer-backfill.js';
import type { PageFetcher, PageProcessor, ResourcePage } from '../src/backfill/types.js';

const MERCHANT_ID = 'm_test';

// ===========================================================================
// parseGid — strict full-GID validator
// ===========================================================================

describe('parseGid (returns full GID on valid, null on malformed)', () => {
  it('returns the full GID on canonical input', () => {
    expect(parseGid('gid://shopify/Customer/12345')).toBe(
      'gid://shopify/Customer/12345',
    );
    expect(parseGid('gid://shopify/Order/9876543210')).toBe(
      'gid://shopify/Order/9876543210',
    );
    expect(parseGid('gid://shopify/ProductVariant/1')).toBe(
      'gid://shopify/ProductVariant/1',
    );
  });

  it('returns null on plain numeric (not a GID)', () => {
    expect(parseGid('12345')).toBeNull();
  });

  it('returns null on empty trailing segment', () => {
    expect(parseGid('gid://shopify/Customer/')).toBeNull();
  });

  it('returns null on non-numeric trailing segment', () => {
    expect(parseGid('gid://shopify/Customer/abc')).toBeNull();
    expect(parseGid('gid://shopify/Customer/12a45')).toBeNull();
  });

  it('returns null on missing or malformed prefix', () => {
    expect(parseGid('shopify/Customer/123')).toBeNull();
    expect(parseGid('gid://other/Customer/123')).toBeNull();
    expect(parseGid('')).toBeNull();
    expect(parseGid('garbage')).toBeNull();
  });

  it('returns null on missing type segment', () => {
    expect(parseGid('gid://shopify//123')).toBeNull();
  });

  it('rejects corrupt inputs (audit-point: no silent passthrough)', () => {
    expect(parseGid('Customer/123')).toBeNull();
    expect(parseGid('123/Customer/gid://shopify')).toBeNull();
  });
});

// ===========================================================================
// GID helpers
// ===========================================================================

describe('toCustomerGid', () => {
  it('wraps a numeric id (string or number) into a Customer GID', () => {
    expect(toCustomerGid('12345')).toBe('gid://shopify/Customer/12345');
    expect(toCustomerGid(67890)).toBe('gid://shopify/Customer/67890');
  });

  it('returns null on non-numeric input — keeps no-silent-passthrough invariant', () => {
    expect(toCustomerGid('abc')).toBeNull();
    expect(toCustomerGid('12.5')).toBeNull();
    expect(toCustomerGid('')).toBeNull();
    expect(toCustomerGid('1 2 3')).toBeNull();
  });

  it('rejects negatives (numeric type → String(-1) = "-1" fails ^\\d+$)', () => {
    expect(toCustomerGid(-1)).toBeNull();
    expect(toCustomerGid(-12345)).toBeNull();
    expect(toCustomerGid('-1')).toBeNull();
  });
});

describe('extractNumericIdFromGid', () => {
  it('extracts the digits from a canonical GID', () => {
    expect(extractNumericIdFromGid('gid://shopify/Customer/12345')).toBe('12345');
    expect(extractNumericIdFromGid('gid://shopify/Order/1')).toBe('1');
  });

  it('returns null on anything not matching the GID pattern', () => {
    expect(extractNumericIdFromGid('12345')).toBeNull();
    expect(extractNumericIdFromGid('gid://shopify/Customer/abc')).toBeNull();
    expect(extractNumericIdFromGid('')).toBeNull();
  });
});

// ===========================================================================
// parseIntOrZero
// ===========================================================================

describe('parseIntOrZero', () => {
  it('parses a numeric string', () => {
    expect(parseIntOrZero('42')).toBe(42);
    expect(parseIntOrZero('0')).toBe(0);
    expect(parseIntOrZero('1000000')).toBe(1_000_000);
  });

  it('returns 0 for null', () => {
    expect(parseIntOrZero(null)).toBe(0);
  });

  it('returns 0 for non-numeric strings', () => {
    expect(parseIntOrZero('garbage')).toBe(0);
    expect(parseIntOrZero('')).toBe(0);
  });

  it('returns the leading integer for mixed strings (parseInt semantics)', () => {
    // parseInt stops at the first non-numeric char. Documented behavior:
    // Shopify never sends mixed strings; this is the parser's natural
    // permissiveness, not a feature.
    expect(parseIntOrZero('42abc')).toBe(42);
  });
});

// ===========================================================================
// parseDateOrNull
// ===========================================================================

describe('parseDateOrNull', () => {
  it('parses a valid ISO-8601 string', () => {
    const d = parseDateOrNull('2025-01-15T10:30:00Z');
    expect(d).not.toBeNull();
    expect(d?.toISOString()).toBe('2025-01-15T10:30:00.000Z');
  });

  it('returns null for null input', () => {
    expect(parseDateOrNull(null)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseDateOrNull('')).toBeNull();
  });

  it('returns null for garbage', () => {
    expect(parseDateOrNull('not-a-date')).toBeNull();
    expect(parseDateOrNull('2025-15-99')).toBeNull(); // Invalid month/day
  });
});

// ===========================================================================
// CustomerPageFetcher — includes estimatedCost formula assertions
// ===========================================================================

describe('CustomerPageFetcher', () => {
  function makeFetcher(graphqlImpl: (...args: unknown[]) => Promise<unknown>) {
    const adminGraphql = vi.fn(graphqlImpl);
    const fetcher = new CustomerPageFetcher({
      graphql: adminGraphql,
    } as unknown as Parameters<typeof CustomerPageFetcher.prototype.constructor>[0]);
    return { fetcher, adminGraphql };
  }

  it('issues GraphQL via the admin client and returns mapped page', async () => {
    const { fetcher, adminGraphql } = makeFetcher(async () => ({
      customers: {
        pageInfo: { endCursor: 'cursor-1', hasNextPage: true },
        nodes: [
          {
            id: 'gid://shopify/Customer/1',
            email: 'a@b.com',
            phone: null,
            firstName: 'Ada',
            lastName: 'Lovelace',
            emailMarketingConsent: { marketingState: 'SUBSCRIBED' },
            smsMarketingConsent: null,
            numberOfOrders: '3',
            tags: ['vip'],
            createdAt: '2025-01-01T00:00:00Z',
            updatedAt: '2025-02-01T00:00:00Z',
          },
        ],
      },
    }));

    const page = await fetcher.fetch({
      merchantId: MERCHANT_ID,
      cursor: null,
      pageSize: 50,
    });

    expect(adminGraphql).toHaveBeenCalledOnce();
    const [merchantId, args] = adminGraphql.mock.calls[0] as [
      string,
      { variables: { first: number; after: string | null }; estimatedCost: number },
    ];
    expect(merchantId).toBe(MERCHANT_ID);
    expect(args.variables.first).toBe(50);
    expect(args.variables.after).toBeNull();
    expect(page.items).toHaveLength(1);
    expect(page.endCursor).toBe('cursor-1');
    expect(page.hasNextPage).toBe(true);
  });

  it('computes estimatedCost via max(10, ceil(pageSize / 5))', async () => {
    // Sample the formula at a few pageSizes — the cost gate is the
    // safety mechanism for the whole backfill; the formula must match
    // what the code does.
    const cases: Array<{ pageSize: number; expected: number }> = [
      { pageSize: 5, expected: 10 }, //  max(10, 1)  = 10  (floor)
      { pageSize: 25, expected: 10 }, // max(10, 5)  = 10  (still floor)
      { pageSize: 50, expected: 10 }, // max(10, 10) = 10  (edge)
      { pageSize: 51, expected: 11 }, // max(10, 11) = 11  (above floor)
      { pageSize: 100, expected: 20 }, // max(10, 20) = 20
      { pageSize: 250, expected: 50 }, // max(10, 50) = 50  (Shopify max page)
    ];

    for (const { pageSize, expected } of cases) {
      const { fetcher, adminGraphql } = makeFetcher(async () => ({}));
      await fetcher.fetch({ merchantId: MERCHANT_ID, cursor: null, pageSize });
      const [, args] = adminGraphql.mock.calls[0] as [string, { estimatedCost: number }];
      expect(args.estimatedCost).toBe(expected);
    }
  });

  it('handles a missing customers connection gracefully', async () => {
    const { fetcher } = makeFetcher(async () => ({}));
    const page = await fetcher.fetch({
      merchantId: MERCHANT_ID,
      cursor: 'x',
      pageSize: 50,
    });
    expect(page.items).toHaveLength(0);
    expect(page.endCursor).toBeNull();
    expect(page.hasNextPage).toBe(false);
  });
});

// ===========================================================================
// BackfillRunner — REAL orchestration tests
//
// Uses a minimal mock prisma. The runner's loop logic (fetcher → processor
// → commitPage → hasNextPage → error classification) is genuinely exercised
// — these are not testing the test harness, they're testing the runner.
// ===========================================================================

interface JobState {
  id: string;
  merchantId: string;
  resource: string;
  status: 'pending' | 'running' | 'completed' | 'paused' | 'failed';
  cursor: string | null;
  pageSize: number;
  itemsProcessed: number;
  pagesProcessed: number;
  attempts: number;
  lastError: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeJob(overrides: Partial<JobState> = {}): JobState {
  const now = new Date();
  return {
    id: 'bf_1',
    merchantId: MERCHANT_ID,
    resource: 'customers',
    status: 'pending',
    cursor: null,
    pageSize: 50,
    itemsProcessed: 0,
    pagesProcessed: 0,
    attempts: 0,
    lastError: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function applyUpdateData(job: JobState, data: Record<string, unknown>): JobState {
  const next = { ...job };
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && typeof v === 'object' && 'increment' in v) {
      const inc = (v as { increment: number }).increment;
      (next as Record<string, unknown>)[k] = ((next as Record<string, number>)[k] ?? 0) + inc;
    } else {
      (next as Record<string, unknown>)[k] = v;
    }
  }
  next.updatedAt = new Date();
  return next;
}

function makeMockPrisma(initialJob: JobState | null = null) {
  let job: JobState | null = initialJob;
  const outboxRows: { merchantId: string; type: string; payload: unknown }[] = [];
  const customerUpserts: { merchantId: string; shopifyCustomerId: string }[] = [];

  const backfillJob = {
    upsert: vi.fn(async (args: { where: unknown; create: Partial<JobState>; update: Partial<JobState> }) => {
      if (job === null) {
        job = makeJob({ ...args.create, merchantId: MERCHANT_ID });
      } else {
        job = applyUpdateData(job, args.update);
      }
      return { ...job };
    }),
    update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
      if (job === null) throw new Error('mock: backfillJob.update before getOrCreate');
      job = applyUpdateData(job, args.data);
      return { ...job };
    }),
    findUnique: vi.fn(async () => (job ? { ...job } : null)),
  };

  const outboxEvent = {
    create: vi.fn(async (args: { data: { merchantId: string; type: string; payload: unknown } }) => {
      outboxRows.push(args.data);
      return args.data;
    }),
  };

  const customer = {
    upsert: vi.fn(async (args: { create: { merchantId: string; shopifyCustomerId: string } }) => {
      customerUpserts.push({
        merchantId: args.create.merchantId,
        shopifyCustomerId: args.create.shopifyCustomerId,
      });
      return args.create;
    }),
  };

  const $transaction = vi.fn(
    async <T>(cb: (tx: { backfillJob: typeof backfillJob; outboxEvent: typeof outboxEvent; customer: typeof customer }) => Promise<T>) =>
      cb({ backfillJob, outboxEvent, customer }),
  );

  return {
    backfillJob,
    outboxEvent,
    customer,
    $transaction,
    // Inspectors:
    getJob: () => job,
    getOutboxRows: () => outboxRows,
    getCustomerUpserts: () => customerUpserts,
  };
}

function makeScriptedFetcher(
  pages: ResourcePage<ShopifyCustomerNode>[],
): PageFetcher<ShopifyCustomerNode> & { calls: { cursor: string | null }[] } {
  const calls: { cursor: string | null }[] = [];
  let i = 0;
  return {
    calls,
    fetch: vi.fn(async (args) => {
      calls.push({ cursor: args.cursor });
      const page = pages[i] ?? { items: [], endCursor: null, hasNextPage: false };
      i++;
      return page;
    }),
  };
}

function makeRecorderProcessor(): PageProcessor<ShopifyCustomerNode> & {
  calls: { itemCount: number }[];
} {
  const calls: { itemCount: number }[] = [];
  return {
    calls,
    processItems: vi.fn(async (args) => {
      calls.push({ itemCount: args.items.length });
    }),
  };
}

function makeNodes(n: number): ShopifyCustomerNode[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `gid://shopify/Customer/${String(i + 1)}`,
    email: `customer-${String(i + 1)}@example.com`,
    phone: null,
    firstName: `First${String(i + 1)}`,
    lastName: 'Last',
    emailMarketingConsent: { marketingState: 'NOT_SUBSCRIBED' },
    smsMarketingConsent: null,
    numberOfOrders: '0',
    tags: [],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  }));
}

describe('BackfillRunner — orchestration', () => {
  it('happy path: fetches each page, advances cursor, marks completed, emits summary outbox event', async () => {
    const prisma = makeMockPrisma();
    const fetcher = makeScriptedFetcher([
      { items: makeNodes(3), endCursor: 'cur-a', hasNextPage: true },
      { items: makeNodes(2), endCursor: 'cur-b', hasNextPage: true },
      { items: makeNodes(1), endCursor: 'cur-c', hasNextPage: false },
    ]);
    const processor = makeRecorderProcessor();

    const runner = new BackfillRunner(
      prisma as unknown as Parameters<typeof BackfillRunner.prototype.constructor>[0],
      fetcher,
      processor,
    );

    const result = await runner.run({
      merchantId: MERCHANT_ID,
      resource: BACKFILL_RESOURCES.customers,
    });

    expect(result.finalStatus).toBe('completed');
    expect(result.pagesProcessed).toBe(3);
    expect(result.itemsProcessed).toBe(6);

    // Fetcher saw cursors in the right sequence: null → cur-a → cur-b.
    // After cur-c hasNextPage=false, no further fetch.
    expect(fetcher.calls).toEqual([
      { cursor: null },
      { cursor: 'cur-a' },
      { cursor: 'cur-b' },
    ]);

    // Processor invoked once per non-empty page.
    expect(processor.calls).toEqual([{ itemCount: 3 }, { itemCount: 2 }, { itemCount: 1 }]);

    // Final job state.
    const job = prisma.getJob();
    expect(job?.status).toBe('completed');
    expect(job?.cursor).toBe('cur-c');
    expect(job?.itemsProcessed).toBe(6);
    expect(job?.pagesProcessed).toBe(3);

    // Outbox: one merchant.backfill_completed event with summary payload.
    const events = prisma.getOutboxRows();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('merchant.backfill_completed');
    expect(events[0]?.payload).toMatchObject({
      resource: 'customers',
      pagesProcessed: 3,
      itemsProcessed: 6,
    });
  });

  it('empty merchant: zero items, no processor invocation, still completes', async () => {
    const prisma = makeMockPrisma();
    const fetcher = makeScriptedFetcher([
      { items: [], endCursor: null, hasNextPage: false },
    ]);
    const processor = makeRecorderProcessor();
    const runner = new BackfillRunner(
      prisma as unknown as Parameters<typeof BackfillRunner.prototype.constructor>[0],
      fetcher,
      processor,
    );

    const result = await runner.run({
      merchantId: MERCHANT_ID,
      resource: BACKFILL_RESOURCES.customers,
    });

    expect(result.finalStatus).toBe('completed');
    expect(result.pagesProcessed).toBe(1);
    expect(result.itemsProcessed).toBe(0);
    expect(processor.calls).toEqual([]); // never called — items.length === 0
    expect(prisma.getJob()?.status).toBe('completed');
  });

  it('token revoked mid-backfill: job → paused, error recorded, no re-throw', async () => {
    const prisma = makeMockPrisma();
    let pageIdx = 0;
    const fetcher: PageFetcher<ShopifyCustomerNode> = {
      fetch: vi.fn(async () => {
        if (pageIdx === 0) {
          pageIdx++;
          return { items: makeNodes(2), endCursor: 'cur-a', hasNextPage: true };
        }
        throw new ShopifyTokenRevokedError('test: token revoked');
      }),
    };
    const processor = makeRecorderProcessor();
    const runner = new BackfillRunner(
      prisma as unknown as Parameters<typeof BackfillRunner.prototype.constructor>[0],
      fetcher,
      processor,
    );

    const result = await runner.run({
      merchantId: MERCHANT_ID,
      resource: BACKFILL_RESOURCES.customers,
    });

    expect(result.finalStatus).toBe('paused');
    // First page was committed; second page fetch threw before commit.
    expect(result.pagesProcessed).toBe(1);

    const job = prisma.getJob();
    expect(job?.status).toBe('paused');
    expect(job?.lastError).toContain('token revoked');
    expect(job?.cursor).toBe('cur-a'); // preserves the last successful cursor
  });

  it('processor error mid-backfill: job → failed, attempts incremented, re-thrown', async () => {
    const prisma = makeMockPrisma();
    const fetcher = makeScriptedFetcher([
      { items: makeNodes(2), endCursor: 'cur-a', hasNextPage: true },
    ]);
    const processor: PageProcessor<ShopifyCustomerNode> = {
      processItems: vi.fn(async () => {
        throw new Error('processor exploded');
      }),
    };
    const runner = new BackfillRunner(
      prisma as unknown as Parameters<typeof BackfillRunner.prototype.constructor>[0],
      fetcher,
      processor,
    );

    await expect(
      runner.run({ merchantId: MERCHANT_ID, resource: BACKFILL_RESOURCES.customers }),
    ).rejects.toThrow('processor exploded');

    const job = prisma.getJob();
    expect(job?.status).toBe('failed');
    expect(job?.attempts).toBe(1);
    expect(job?.lastError).toContain('processor exploded');

    // Cursor stays at its prior value — but NOT because rollback "un-did"
    // the commitPage call. The runner orders processItems BEFORE commitPage
    // inside the uow callback, so when processItems throws, commitPage is
    // never reached. The mock therefore correctly reflects the real-DB
    // outcome for cursor specifically. (Transactional rollback of any
    // partial customer upserts the processor managed to do BEFORE
    // throwing is a real-DB guarantee tested in M3-Smoke #2, not here.)
    expect(job?.cursor).toBeNull();
    expect(job?.pagesProcessed).toBe(0);
  });

  it('already-completed job: short-circuits with stored counters', async () => {
    const initialJob = makeJob({
      status: 'completed',
      itemsProcessed: 42,
      pagesProcessed: 7,
    });
    const prisma = makeMockPrisma(initialJob);
    const fetcher = makeScriptedFetcher([]);
    const processor = makeRecorderProcessor();
    const runner = new BackfillRunner(
      prisma as unknown as Parameters<typeof BackfillRunner.prototype.constructor>[0],
      fetcher,
      processor,
    );

    const result = await runner.run({
      merchantId: MERCHANT_ID,
      resource: BACKFILL_RESOURCES.customers,
    });

    expect(result.finalStatus).toBe('completed');
    expect(result.itemsProcessed).toBe(42);
    expect(result.pagesProcessed).toBe(7);
    // No fetcher or processor calls — short-circuit.
    expect(fetcher.calls).toEqual([]);
    expect(processor.calls).toEqual([]);
  });

  it('resumes from persisted cursor on re-run', async () => {
    // Simulate a previous run that processed 1 page and recorded cursor.
    const initialJob = makeJob({
      status: 'paused',
      cursor: 'persisted-cursor',
      itemsProcessed: 3,
      pagesProcessed: 1,
    });
    const prisma = makeMockPrisma(initialJob);
    const fetcher = makeScriptedFetcher([
      { items: makeNodes(2), endCursor: 'cur-final', hasNextPage: false },
    ]);
    const processor = makeRecorderProcessor();
    const runner = new BackfillRunner(
      prisma as unknown as Parameters<typeof BackfillRunner.prototype.constructor>[0],
      fetcher,
      processor,
    );

    const result = await runner.run({
      merchantId: MERCHANT_ID,
      resource: BACKFILL_RESOURCES.customers,
    });

    // Fetcher's first call uses the persisted cursor.
    expect(fetcher.calls[0]?.cursor).toBe('persisted-cursor');
    expect(result.finalStatus).toBe('completed');
    // Resumed counters carry forward + new page's items.
    expect(result.pagesProcessed).toBe(2);
    expect(result.itemsProcessed).toBe(5);
  });
});

// ===========================================================================
// Discriminator class sanity (kept from prior version)
// ===========================================================================

describe('ShopifyTokenRevokedError boundary', () => {
  it('is non-retryable and carries the right code', () => {
    const e = new ShopifyTokenRevokedError('test');
    expect(e instanceof ShopifyTokenRevokedError).toBe(true);
    expect(e.retryable).toBe(false);
    expect(e.code).toBe('shopify.token_revoked');
  });
});

// Re-export to suppress "unused" lint when withTenantScope isn't directly
// invoked in tests but IS the mechanism the runner relies on via the
// repository's `assertScopeMatchesMerchant`.
void withTenantScope;
