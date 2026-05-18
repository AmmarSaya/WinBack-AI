import type { LoaderFunctionArgs } from '@remix-run/node';
import { withSystemScope } from '@winback/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { loader as indexLoader } from '../../app/routes/_index.js';
import { loader as settingsLoader } from '../../app/routes/settings.js';

import { assertRead, createTestMerchant, getTestClient, resetDb } from './setup.js';

/**
 * Loader tests for the admin routes that actually have loaders.
 * `/customers` and `/campaigns` are static placeholders (no loader) per
 * design.md — not tested here. `/_index` proves install (Merchant lookup);
 * `/settings` reads MerchantSettings under withTenantScope (THE ALS-bug
 * surface).
 *
 * The tenant-isolation test (last one) is the strongest single signal —
 * two merchants in the same DB, two settings loaders, distinct return
 * values. If withTenantScope ALS leaks, one loader returns the other's
 * data and the test fails.
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
});
