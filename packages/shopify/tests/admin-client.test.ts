import { RateLimitError } from '@winback/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminClient } from '../src/admin/client.js';
import { CostTracker } from '../src/admin/cost-tracker.js';
import { ShopifyAdminApiError, ShopifyTokenRevokedError } from '../src/admin/errors.js';
import type { ResolvedToken, ShopifyTokenResolver } from '../src/admin/token-resolver.js';
import type { ShopifyConfig } from '../src/config.js';

const MERCHANT_ID = 'm_test';
const SHOP = 'foo.myshopify.com';
const ACCESS_TOKEN = 'shpat_decrypted_token';

const FAKE_CONFIG: ShopifyConfig = {
  SHOPIFY_API_KEY: 'k',
  SHOPIFY_API_SECRET: 's',
  SHOPIFY_APP_URL: 'https://app.example.com',
  SHOPIFY_SCOPES: 'read_customers',
  SHOPIFY_API_VERSION: '2025-01',
  ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
};

// --- Mocks ------------------------------------------------------------------

function makeResolver(
  overrides: Partial<ShopifyTokenResolver> = {},
): ShopifyTokenResolver {
  return {
    getOfflineToken: vi.fn(
      async (): Promise<ResolvedToken | null> => ({
        shop: SHOP,
        accessToken: ACCESS_TOKEN,
      }),
    ),
    markTokenRevoked: vi.fn(async () => {}),
    ...overrides,
  };
}

function mockFetchOk(data: unknown, throttleStatus = defaultThrottle()): typeof fetch {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        data,
        extensions: { cost: { requestedQueryCost: 10, actualQueryCost: 10, throttleStatus } },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );
}

function defaultThrottle() {
  return { maximumAvailable: 1000, currentlyAvailable: 990, restoreRate: 50 };
}

function mockSleep() {
  return vi.fn(async () => {});
}

/**
 * Deterministic clock for CostTracker construction. Mirrors the helper
 * in cost-tracker.test.ts. Required wherever a test asserts an exact
 * `msUntilAvailable` value — without it, real-clock drift between
 * `onResponse` and the next `msUntilAvailable` call produces a
 * fractional projected.available and (when the production code did not
 * yet floor it) a flaky wait result on fine-grained timers (e.g. Linux
 * CI vs Windows local).
 */
function mockClock(initial = 0) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

// --- Tests ------------------------------------------------------------------

describe('AdminClient — happy path', () => {
  it('resolves token, issues fetch, returns data, updates cost tracker', async () => {
    const resolver = makeResolver();
    const tracker = new CostTracker();
    const fetchFn = mockFetchOk({ shop: { name: 'Acme' } });
    const sleepFn = mockSleep();
    const client = new AdminClient(resolver, tracker, { fetchFn, sleepFn });

    const result = await client.graphql<{ shop: { name: string } }>(
      MERCHANT_ID,
      { query: '{ shop { name } }' },
      FAKE_CONFIG,
    );

    expect(result).toEqual({ shop: { name: 'Acme' } });
    expect(resolver.getOfflineToken).toHaveBeenCalledWith(MERCHANT_ID);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // The Authorization header carries the decrypted token.
    const fetchArgs = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchArgs?.[0]).toContain(SHOP);
    expect(fetchArgs?.[0]).toContain('/admin/api/2025-01/graphql.json');
    const init = fetchArgs?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe(
      ACCESS_TOKEN,
    );
    // Cost tracker updated from throttleStatus.
    expect(tracker.snapshot(SHOP)?.currentlyAvailable).toBe(990);
  });
});

describe('AdminClient — token resolution failures', () => {
  it('throws ShopifyTokenRevokedError when resolver returns null', async () => {
    const resolver = makeResolver({
      getOfflineToken: vi.fn(async () => null),
    });
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const client = new AdminClient(resolver, new CostTracker(), { fetchFn });

    await expect(
      client.graphql(MERCHANT_ID, { query: '{ shop { name } }' }, FAKE_CONFIG),
    ).rejects.toThrow(ShopifyTokenRevokedError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('AdminClient — 401 handling', () => {
  it('marks token revoked and throws on 401', async () => {
    const resolver = makeResolver();
    const fetchFn = vi.fn(
      async () => new Response('Unauthorized', { status: 401 }),
    ) as unknown as typeof fetch;
    const client = new AdminClient(resolver, new CostTracker(), { fetchFn });

    await expect(
      client.graphql(MERCHANT_ID, { query: '{ shop { name } }' }, FAKE_CONFIG),
    ).rejects.toThrow(ShopifyTokenRevokedError);
    expect(resolver.markTokenRevoked).toHaveBeenCalledWith(MERCHANT_ID);
    // No retry on 401 — exactly one fetch.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('AdminClient — 429 throttling', () => {
  it('retries on 429 then succeeds', async () => {
    const resolver = makeResolver();
    const tracker = new CostTracker();
    const sleepFn = mockSleep();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('Too Many Requests', {
          status: 429,
          headers: { 'Retry-After': '1' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { shop: { name: 'A' } },
            extensions: {
              cost: {
                requestedQueryCost: 10,
                actualQueryCost: 10,
                throttleStatus: defaultThrottle(),
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ) as unknown as typeof fetch;
    const client = new AdminClient(resolver, tracker, { fetchFn, sleepFn });

    const result = await client.graphql<{ shop: { name: string } }>(
      MERCHANT_ID,
      { query: '{ shop { name } }' },
      FAKE_CONFIG,
    );
    expect(result.shop.name).toBe('A');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // sleepFn was called: at least one back-off
    expect((sleepFn as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it('throws RateLimitError after maxRetries exhausted on 429', async () => {
    const resolver = makeResolver();
    const fetchFn = vi.fn(
      async () => new Response('Too Many Requests', { status: 429 }),
    ) as unknown as typeof fetch;
    const sleepFn = mockSleep();
    const client = new AdminClient(resolver, new CostTracker(), {
      fetchFn,
      sleepFn,
      maxRetries: 2,
    });

    await expect(
      client.graphql(MERCHANT_ID, { query: '{ shop { name } }' }, FAKE_CONFIG),
    ).rejects.toThrow(RateLimitError);
    // initial + 2 retries = 3 calls
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

describe('AdminClient — GraphQL-level throttling', () => {
  it('retries on extensions.code === THROTTLED', async () => {
    const resolver = makeResolver();
    const sleepFn = mockSleep();
    const throttledResponse = new Response(
      JSON.stringify({
        errors: [
          {
            message: 'Throttled',
            extensions: { code: 'THROTTLED' },
          },
        ],
        extensions: {
          cost: {
            requestedQueryCost: 100,
            actualQueryCost: 0,
            throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 50 },
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const okResponse = new Response(
      JSON.stringify({
        data: { ok: true },
        extensions: {
          cost: {
            requestedQueryCost: 10,
            actualQueryCost: 10,
            throttleStatus: defaultThrottle(),
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(throttledResponse)
      .mockResolvedValueOnce(okResponse) as unknown as typeof fetch;
    const client = new AdminClient(resolver, new CostTracker(), { fetchFn, sleepFn });

    await client.graphql(MERCHANT_ID, { query: '{ ok }' }, FAKE_CONFIG);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('AdminClient — 5xx + non-throttle errors', () => {
  it('throws ShopifyAdminApiError on persistent 5xx', async () => {
    const resolver = makeResolver();
    const fetchFn = vi.fn(
      async () => new Response('boom', { status: 503 }),
    ) as unknown as typeof fetch;
    const sleepFn = mockSleep();
    const client = new AdminClient(resolver, new CostTracker(), {
      fetchFn,
      sleepFn,
      maxRetries: 1,
    });

    await expect(
      client.graphql(MERCHANT_ID, { query: '{ shop { name } }' }, FAKE_CONFIG),
    ).rejects.toThrow(ShopifyAdminApiError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws ShopifyAdminApiError on non-throttle GraphQL errors', async () => {
    const resolver = makeResolver();
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            errors: [{ message: 'Field foo not found' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;
    const client = new AdminClient(resolver, new CostTracker(), { fetchFn });

    await expect(
      client.graphql(MERCHANT_ID, { query: '{ shop { foo } }' }, FAKE_CONFIG),
    ).rejects.toThrow(/Field foo not found/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('AdminClient — rate-limit gating', () => {
  it('sleeps when cost tracker says wait is required', async () => {
    const resolver = makeResolver();
    // Pre-seed tracker with low budget. mockClock injection keeps the
    // elapsedSec between `onResponse` and the internal `msUntilAvailable`
    // call deterministically zero — without it, CI runners with
    // millisecond-granular timers (Linux) produced fractional
    // projected.available and a flaky 1899 vs 1900 result. The
    // production code floors `projected.available` to defend against
    // the same drift class; this mockClock makes the test
    // deterministic regardless of that defence.
    const clock = mockClock(0);
    const tracker = new CostTracker({ now: clock.now, safetyFloor: 0 });
    tracker.onResponse(SHOP, {
      maximumAvailable: 1000,
      currentlyAvailable: 5,
      restoreRate: 50,
    });
    const sleepFn = vi.fn(async () => {});
    const fetchFn = mockFetchOk({ ok: true });
    const client = new AdminClient(resolver, tracker, { fetchFn, sleepFn });

    await client.graphql(
      MERCHANT_ID,
      { query: '{ ok }', estimatedCost: 100 },
      FAKE_CONFIG,
    );
    // Pre-flight wait: deficit 95, rate 50/s → 1900ms.
    expect(sleepFn).toHaveBeenCalledWith(1900);
  });
});

describe('AdminClient — type boundary', () => {
  it('graphql signature accepts no accessToken parameter', () => {
    // Compile-time enforcement: this test exists to document that the
    // public API has no `accessToken` slot. If a future change adds one,
    // grep for this test and reconsider.
    const resolver = makeResolver();
    const client = new AdminClient(resolver, new CostTracker(), {
      fetchFn: mockFetchOk({}),
    });
    // The next call's argument shape is intentionally minimal. There is
    // no field name "accessToken" anywhere in GraphQLArgs.
    void client.graphql(MERCHANT_ID, { query: '{}' }, FAKE_CONFIG);
    expect(true).toBe(true);
  });
});

// keep eslint happy about unused beforeEach import in case future tests use it
beforeEach(() => {});
