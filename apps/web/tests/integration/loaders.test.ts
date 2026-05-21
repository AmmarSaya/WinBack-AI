import type { LoaderFunctionArgs } from '@remix-run/node';
import { withSystemScope } from '@winback/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { loader as customersLoader } from '../../app/routes/customers.js';
import { loader as indexLoader } from '../../app/routes/_index.js';
import { loader as settingsLoader } from '../../app/routes/settings.js';

import { assertRead, createTestMerchant, getTestClient, resetDb } from './setup.js';

/**
 * Loader tests for the admin routes with loaders.
 *   - `/_index`    — install proof (Merchant lookup) + state-band counts.
 *   - `/settings`  — reads MerchantSettings under withTenantScope.
 *   - `/customers` — Epic E UI session: paginated CustomerScore list under
 *                    withTenantScope.  `/campaigns` is still a static
 *                    placeholder (no loader); ignored here.
 *
 * The tenant-isolation test (the settings one) is the strongest single
 * signal — two merchants in the same DB, two parallel loaders, distinct
 * return values.  If withTenantScope ALS leaks, one loader returns the
 * other's data and the test fails.
 */

const SHOP_A = 'merchant-a.myshopify.com';
const SHOP_B = 'merchant-b.myshopify.com';

async function invokeIndex(request: Request): Promise<Response> {
  const args: LoaderFunctionArgs = { request, params: {}, context: {} };
  try {
    return (await indexLoader(args)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function invokeSettings(request: Request): Promise<Response> {
  const args: LoaderFunctionArgs = { request, params: {}, context: {} };
  try {
    return (await settingsLoader(args)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function invokeCustomers(request: Request): Promise<Response> {
  const args: LoaderFunctionArgs = { request, params: {}, context: {} };
  try {
    return (await customersLoader(args)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

function urlFor(path: string, shop?: string): Request {
  const url = new URL(`https://test.invalid${path}`);
  if (shop !== undefined) url.searchParams.set('shop', shop);
  return new Request(url.toString(), { method: 'GET' });
}

describe('admin loaders (integration, real Postgres)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await getTestClient().$disconnect();
  });

  // ----- /_index -----------------------------------------------------------

  it('_index: valid shop with merchant → 200 json with shop + installedAt', async () => {
    await createTestMerchant(SHOP_A);

    const res = await invokeIndex(urlFor('/', SHOP_A));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { shop: string; installedAt: string };
    expect(body.shop).toBe(SHOP_A);
    expect(typeof body.installedAt).toBe('string');
    expect(new Date(body.installedAt).toString()).not.toBe('Invalid Date');
  });

  it('_index: valid shop with NO merchant → 302 to /auth', async () => {
    const res = await invokeIndex(urlFor('/', SHOP_A));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      `/auth?shop=${encodeURIComponent(SHOP_A)}`,
    );
  });

  it('_index: missing shop param → 400', async () => {
    const res = await invokeIndex(urlFor('/'));
    expect(res.status).toBe(400);
  });

  it('_index: invalid shop domain → 400', async () => {
    const res = await invokeIndex(urlFor('/', 'not a real shop'));
    expect(res.status).toBe(400);
  });

  // ----- /settings ---------------------------------------------------------

  it('settings: valid shop with merchant + settings → 200 json with settings fields', async () => {
    await createTestMerchant(SHOP_A);

    const res = await invokeSettings(urlFor('/settings', SHOP_A));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attributionDirectWindowDays: number;
      attributionAssistedWindowDays: number;
      sendTimeStartHour: number;
      sendTimeEndHour: number;
      monthlyAiSpendCapCents: string; // BigInt → string at the boundary
      monthlySendsCap: number;
    };
    expect(typeof body.attributionDirectWindowDays).toBe('number');
    expect(typeof body.monthlyAiSpendCapCents).toBe('string');
    // Schema defaults are set by Prisma; we don't assert exact values
    // (those are the @winback/db tests' job), just that the shape arrived.
  });

  it('settings: valid shop with NO merchant → 302 to /auth', async () => {
    const res = await invokeSettings(urlFor('/settings', SHOP_A));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      `/auth?shop=${encodeURIComponent(SHOP_A)}`,
    );
  });

  it('settings: missing shop param → 400', async () => {
    const res = await invokeSettings(urlFor('/settings'));
    expect(res.status).toBe(400);
  });

  // ----- The ALS-bug-class catcher ----------------------------------------

  it('settings: tenant isolation — two merchants, each loader returns its own data', async () => {
    const idA = await createTestMerchant(SHOP_A);
    const idB = await createTestMerchant(SHOP_B);

    // Distinguish A's settings from B's defaults so the assertion can tell
    // which merchant's data the loader returned. Settings are tenant-
    // scoped writes, so we use system scope for cross-tenant test setup.
    await withSystemScope('test.distinct_settings', async () => {
      await getTestClient().merchantSettings.update({
        where: { merchantId: idA },
        data: { attributionDirectWindowDays: 99 },
      });
      await getTestClient().merchantSettings.update({
        where: { merchantId: idB },
        data: { attributionDirectWindowDays: 42 },
      });
    });

    // Promise.all interleaves the two loaders on the same event loop —
    // not OS-thread-parallel, but the interleaving is exactly the shape
    // where ALS context leakage between async chains would manifest.
    const [resA, resB] = await Promise.all([
      invokeSettings(urlFor('/settings', SHOP_A)),
      invokeSettings(urlFor('/settings', SHOP_B)),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const bodyA = (await resA.json()) as { attributionDirectWindowDays: number };
    const bodyB = (await resB.json()) as { attributionDirectWindowDays: number };

    expect(bodyA.attributionDirectWindowDays).toBe(99);
    expect(bodyB.attributionDirectWindowDays).toBe(42);
    // If withTenantScope's ALS leaked across the parallel calls,
    // one of these would carry the other's value (or both the same).
  });

  // ----- /customers (Epic E UI session) ------------------------------------

  it('customers: valid shop with no CustomerScore rows yet → 200 with empty rows + null nextCursor', async () => {
    await createTestMerchant(SHOP_A);

    const res = await invokeCustomers(urlFor('/customers', SHOP_A));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      shop: string;
      filterStates: string[];
      rows: unknown[];
      nextCursor: string | null;
    };
    expect(body.shop).toBe(SHOP_A);
    expect(body.filterStates).toEqual([]);
    expect(body.rows).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it('customers: mixed-state cohort → returns sorted rows; state filter restricts results', async () => {
    const merchantId = await createTestMerchant(SHOP_A);

    // Seed: 3 customers across distinct state bands with distinct churn risk
    // scores so the sort order is deterministic.  Direct Prisma writes
    // under system scope — bypass the webhook handlers (we're testing the
    // loader, not the scoring pipeline).
    await withSystemScope('test.seed_customers_route', async () => {
      const client = getTestClient();
      const customers = await Promise.all([
        client.customer.create({
          data: {
            merchantId,
            shopifyCustomerId: 'gid://shopify/Customer/700001',
            email: 'alice@example.com',
            firstName: 'Alice',
            lastName: 'A',
            state: 'at_risk',
          },
          select: { id: true },
        }),
        client.customer.create({
          data: {
            merchantId,
            shopifyCustomerId: 'gid://shopify/Customer/700002',
            email: 'bob@example.com',
            firstName: 'Bob',
            lastName: 'B',
            state: 'active',
          },
          select: { id: true },
        }),
        client.customer.create({
          data: {
            merchantId,
            shopifyCustomerId: 'gid://shopify/Customer/700003',
            email: 'carol@example.com',
            firstName: 'Carol',
            lastName: 'C',
            state: 'dormant',
          },
          select: { id: true },
        }),
      ]);
      const [aliceId, bobId, carolId] = customers.map((c) => c.id);
      const computedAt = new Date('2026-05-20T00:00:00Z');
      await Promise.all([
        client.customerScore.create({
          data: {
            merchantId,
            customerId: aliceId!,
            rDays: 100,
            fCount: 3,
            mCents: 50_000n,
            currency: 'USD',
            rQuintile: 3,
            fQuintile: 3,
            mQuintile: 4,
            churnRiskScore: 0.6, // highest risk → top of list
            computedAt,
          },
        }),
        client.customerScore.create({
          data: {
            merchantId,
            customerId: bobId!,
            rDays: 5,
            fCount: 5,
            mCents: 200_000n,
            currency: 'USD',
            rQuintile: 5,
            fQuintile: 5,
            mQuintile: 5,
            churnRiskScore: 0.0,
            computedAt,
          },
        }),
        client.customerScore.create({
          data: {
            merchantId,
            customerId: carolId!,
            rDays: 250,
            fCount: 1,
            mCents: 10_000n,
            currency: 'USD',
            rQuintile: 1,
            fQuintile: 1,
            mQuintile: 1,
            churnRiskScore: 0.8666666667,
            computedAt,
          },
        }),
      ]);
    });

    // Unfiltered: expect 3 rows sorted by churnRiskScore DESC.
    const resAll = await invokeCustomers(urlFor('/customers', SHOP_A));
    expect(resAll.status).toBe(200);
    const bodyAll = (await resAll.json()) as {
      rows: Array<{ email: string | null; churnRiskScore: number | null; state: string }>;
      nextCursor: string | null;
    };
    expect(bodyAll.rows).toHaveLength(3);
    // Order: carol (0.87) → alice (0.6) → bob (0.0)
    expect(bodyAll.rows[0]?.email).toBe('carol@example.com');
    expect(bodyAll.rows[0]?.state).toBe('dormant');
    expect(bodyAll.rows[1]?.email).toBe('alice@example.com');
    expect(bodyAll.rows[1]?.state).toBe('at_risk');
    expect(bodyAll.rows[2]?.email).toBe('bob@example.com');
    expect(bodyAll.rows[2]?.state).toBe('active');
    expect(bodyAll.nextCursor).toBeNull();

    // Filtered by state=at_risk,dormant → only Alice + Carol.
    const url = new URL(`https://test.invalid/customers`);
    url.searchParams.set('shop', SHOP_A);
    url.searchParams.set('state', 'at_risk,dormant');
    const resFiltered = await invokeCustomers(new Request(url.toString(), { method: 'GET' }));
    expect(resFiltered.status).toBe(200);
    const bodyFiltered = (await resFiltered.json()) as {
      filterStates: string[];
      rows: Array<{ email: string | null; state: string }>;
    };
    expect(bodyFiltered.filterStates.sort()).toEqual(['at_risk', 'dormant']);
    expect(bodyFiltered.rows.map((r) => r.email).sort()).toEqual([
      'alice@example.com',
      'carol@example.com',
    ]);
  });

  it('customers: valid shop with NO merchant → 302 to /auth', async () => {
    const res = await invokeCustomers(urlFor('/customers', SHOP_A));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/auth?shop=${encodeURIComponent(SHOP_A)}`);
  });

  it('customers: missing shop param → 400', async () => {
    const res = await invokeCustomers(urlFor('/customers'));
    expect(res.status).toBe(400);
  });
});
