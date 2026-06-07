import type { LoaderFunctionArgs } from '@remix-run/node';
import { withSystemScope } from '@winback/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { loader as indexLoader } from '../../app/routes/_index.js';
import { loader as customersLoader } from '../../app/routes/customers.js';
import { loader as settingsLoader } from '../../app/routes/settings.js';

import { makeSessionToken } from './jwt-helper.js';
import { assertRead, createTestMerchant, getTestClient, resetDb } from './setup.js';

/**
 * Loader tests for the admin routes with loaders.
 *   - `/_index`    — install proof (Merchant lookup) + state-band counts.
 *   - `/settings`  — reads MerchantSettings under withTenantScope.
 *   - `/customers` — Epic E UI session: paginated CustomerScore list under
 *                    withTenantScope.  `/campaigns` is still a static
 *                    placeholder (no loader); ignored here.
 *
 * Two describe blocks below:
 *
 *   1. "?shop-only requests → 401 (L2-H1 closure-lock)" — proves that the
 *      pre-B4 cross-tenant exploit (?shop= without a session token
 *      returning victim data) stays closed. These tests use realistic
 *      fixtures (created merchants, seeded customers, settings overrides)
 *      so a regression that re-introduces shop-only auth would surface
 *      ACTUAL data leak in the response body, not just a status flip.
 *      Each test asserts 401 + body shape + absence of leak fields.
 *
 *   2. JWT auth path (M-8 Commit 3) — the only success path post-B4. The
 *      tenant-isolation test under that block is the strongest single
 *      signal: two merchants in the same DB, two parallel loaders, two
 *      Bearer JWTs, distinct return values. If withTenantScope ALS leaks,
 *      one loader returns the other's data and the test fails.
 */

const SHOP_A = 'merchant-a.myshopify.com';
const SHOP_B = 'merchant-b.myshopify.com';

interface SessionTokenRequiredBody {
  readonly error: string;
  readonly reason?: string;
}

/**
 * Closure-lock helper for the L2-H1 exploit class. Asserts that a
 * ?shop-only response without a session token:
 *   1. Is exactly 401 (not 200, not 302).
 *   2. Has the documented `{error: 'session_token_required', reason: 'no_token'}`
 *      shape from admin-auth.server.ts.
 *   3. Contains NONE of the merchant / customer / settings field names the
 *      pre-B4 fallback would have leaked.
 */
async function assertNoDataLeak401(res: Response): Promise<void> {
  expect(res.status).toBe(401);
  const raw = await res.text();
  // The 401 throw uses Remix `json()`, so the body parses as
  // SessionTokenRequiredBody. Tested as both a structural assertion and
  // a substring no-leak check.
  const body = JSON.parse(raw) as SessionTokenRequiredBody;
  expect(body.error).toBe('session_token_required');
  expect(body.reason).toBe('no_token');
  // Substring sweep — any of these in the body would indicate the
  // legacy lookupMerchantOrRedirect path leaked data despite the
  // 401 status. The closure-lock is "no data, not just no 200."
  for (const field of [
    'installedAt',
    'attributionDirectWindowDays',
    'monthlyAiSpendCapCents',
    'churnRiskScore',
    'shopifyCustomerId',
    'alice@example.com',
    'bob@example.com',
    'carol@example.com',
    'rows',
    'nextCursor',
    'filterStates',
  ]) {
    expect(raw, `401 body must not leak '${field}'`).not.toContain(field);
  }
}

async function invokeIndex(request: Request): Promise<Response> {
  const args: LoaderFunctionArgs = { request, params: {}, context: {} };
  try {
    return (await indexLoader(args));
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function invokeSettings(request: Request): Promise<Response> {
  const args: LoaderFunctionArgs = { request, params: {}, context: {} };
  try {
    return (await settingsLoader(args));
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function invokeCustomers(request: Request): Promise<Response> {
  const args: LoaderFunctionArgs = { request, params: {}, context: {} };
  try {
    return (await customersLoader(args));
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

describe('?shop-only requests → 401 (B4 / L2-H1 closure-lock, integration, real Postgres)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await getTestClient().$disconnect();
  });

  // Each test seeds REALISTIC fixtures (a created merchant, distinct
  // settings, a 3-customer cohort) so a regression that re-introduces the
  // pre-B4 shop-only Merchant lookup would leak actual data into the 401
  // body. The closure is "no data" not just "no 200."

  // ----- /_index -----------------------------------------------------------

  it('_index: ?shop with EXISTING merchant → 401, no installedAt leak (pre-B4 was 200)', async () => {
    await createTestMerchant(SHOP_A);
    const res = await invokeIndex(urlFor('/', SHOP_A));
    await assertNoDataLeak401(res);
  });

  it('_index: ?shop with NO merchant → 401, no /auth redirect (pre-B4 was 302)', async () => {
    const res = await invokeIndex(urlFor('/', SHOP_A));
    expect(res.headers.get('location')).toBeNull();
    await assertNoDataLeak401(res);
  });

  it('_index: missing shop param → 400 (unchanged from pre-B4)', async () => {
    const res = await invokeIndex(urlFor('/'));
    expect(res.status).toBe(400);
  });

  it('_index: invalid shop domain → 400 (unchanged from pre-B4)', async () => {
    const res = await invokeIndex(urlFor('/', 'not a real shop'));
    expect(res.status).toBe(400);
  });

  // ----- /settings ---------------------------------------------------------

  it('settings: ?shop with merchant + settings → 401, no settings leak (pre-B4 was 200)', async () => {
    await createTestMerchant(SHOP_A);
    const res = await invokeSettings(urlFor('/settings', SHOP_A));
    await assertNoDataLeak401(res);
  });

  it('settings: ?shop with NO merchant → 401, no /auth redirect (pre-B4 was 302)', async () => {
    const res = await invokeSettings(urlFor('/settings', SHOP_A));
    expect(res.headers.get('location')).toBeNull();
    await assertNoDataLeak401(res);
  });

  it('settings: missing shop param → 400 (unchanged from pre-B4)', async () => {
    const res = await invokeSettings(urlFor('/settings'));
    expect(res.status).toBe(400);
  });

  it('settings: parallel cross-tenant ?shop calls → both 401, no settings cross-leak (pre-B4 was 200/200)', async () => {
    const idA = await createTestMerchant(SHOP_A);
    const idB = await createTestMerchant(SHOP_B);
    // Distinct settings under system scope so a regression that re-introduces
    // the shop-only path would leak distinguishable values.
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
    const [resA, resB] = await Promise.all([
      invokeSettings(urlFor('/settings', SHOP_A)),
      invokeSettings(urlFor('/settings', SHOP_B)),
    ]);
    await assertNoDataLeak401(resA);
    await assertNoDataLeak401(resB);
  });

  // ----- /customers (Epic E UI session) ------------------------------------

  it('customers: ?shop with empty cohort → 401, no rows/cursor leak (pre-B4 was 200 empty)', async () => {
    await createTestMerchant(SHOP_A);
    const res = await invokeCustomers(urlFor('/customers', SHOP_A));
    await assertNoDataLeak401(res);
  });

  it('customers: ?shop with seeded 3-customer cohort → 401, no email/state/score leak (pre-B4 was 200 with rows)', async () => {
    const merchantId = await createTestMerchant(SHOP_A);
    // Seed: 3 customers + scores. If the closure regresses, the email
    // strings 'alice@example.com' / 'bob@example.com' / 'carol@example.com'
    // and the churnRiskScore numbers would appear in the 401 body —
    // assertNoDataLeak401 substring-sweeps for all three.
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
            churnRiskScore: 0.6,
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

    // Unfiltered and state-filtered both must be 401-no-leak. Pre-B4 these
    // returned 200 with the seeded data; the closure asserts neither path
    // leaks anything.
    const resAll = await invokeCustomers(urlFor('/customers', SHOP_A));
    await assertNoDataLeak401(resAll);

    const url = new URL(`https://test.invalid/customers`);
    url.searchParams.set('shop', SHOP_A);
    url.searchParams.set('state', 'at_risk,dormant');
    const resFiltered = await invokeCustomers(
      new Request(url.toString(), { method: 'GET' }),
    );
    await assertNoDataLeak401(resFiltered);
  });

  it('customers: ?shop with NO merchant → 401, no /auth redirect (pre-B4 was 302)', async () => {
    const res = await invokeCustomers(urlFor('/customers', SHOP_A));
    expect(res.headers.get('location')).toBeNull();
    await assertNoDataLeak401(res);
  });

  it('customers: missing shop param → 400 (unchanged from pre-B4)', async () => {
    const res = await invokeCustomers(urlFor('/customers'));
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// JWT auth path (M-8 Commit 3) — Authorization: Bearer header or
// ?id_token= query. The only success path post-B4; the legacy ?shop-only
// fallback above now 401s instead of returning data.
// ===========================================================================

function jwtRequest(
  path: string,
  opts: { shop?: string; bearer?: string; idToken?: string; host?: string } = {},
): Request {
  const url = new URL(`https://test.invalid${path}`);
  if (opts.shop !== undefined) url.searchParams.set('shop', opts.shop);
  if (opts.idToken !== undefined) url.searchParams.set('id_token', opts.idToken);
  if (opts.host !== undefined) url.searchParams.set('host', opts.host);
  const headers = new Headers();
  if (opts.bearer !== undefined) {
    headers.set('authorization', `Bearer ${opts.bearer}`);
  }
  return new Request(url.toString(), { method: 'GET', headers });
}

describe('admin loaders — JWT auth path (M-8 Commit 3, integration)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await getTestClient().$disconnect();
  });

  // -------------------------------------------------------------------------
  // L-1. Valid Bearer JWT + Merchant exists → 200
  // -------------------------------------------------------------------------

  it('L-1. _index: valid Bearer JWT + Merchant exists → 200 json with shop + installedAt', async () => {
    await createTestMerchant(SHOP_A);
    const token = makeSessionToken(SHOP_A);

    const res = await invokeIndex(jwtRequest('/', { shop: SHOP_A, bearer: token }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { shop: string; installedAt: string };
    expect(body.shop).toBe(SHOP_A);
    expect(typeof body.installedAt).toBe('string');
  });

  // -------------------------------------------------------------------------
  // L-2. Valid id_token query + Merchant exists → 200
  // -------------------------------------------------------------------------

  it('L-2. _index: valid ?id_token query + Merchant exists → 200', async () => {
    await createTestMerchant(SHOP_A);
    const token = makeSessionToken(SHOP_A);

    const res = await invokeIndex(jwtRequest('/', { shop: SHOP_A, idToken: token }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { shop: string };
    expect(body.shop).toBe(SHOP_A);
  });

  // -------------------------------------------------------------------------
  // L-3. Bearer JWT overrides id_token query (precedence)
  //
  // Bearer JWT is for SHOP_A (correct); id_token query is for SHOP_B
  // (wrong dest for the expected shop SHOP_A). If query were preferred,
  // verification would fail with wrong_dest and we'd see 401. 200 ==
  // Bearer was selected, query was ignored.
  // -------------------------------------------------------------------------

  it('L-3. _index: Bearer JWT (valid, correct dest) overrides id_token query (valid, wrong dest) → 200', async () => {
    await createTestMerchant(SHOP_A);
    const bearer = makeSessionToken(SHOP_A);
    const queryToken = makeSessionToken(SHOP_B); // dest=SHOP_B, would fail against SHOP_A

    const res = await invokeIndex(
      jwtRequest('/', { shop: SHOP_A, bearer, idToken: queryToken }),
    );

    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // L-3b. SECURITY LOCK — Bearer present but invalid signature, plus
  // a VALID id_token query → 401 (no fallback to query).
  //
  // Locks the downgrade-attack defence: a bad header doesn't degrade to
  // "try query instead". Once the client sends a Bearer credential, that
  // commits them to the header-strict path. Any failure surfaces as 401.
  // -------------------------------------------------------------------------

  it('L-3b. _index: Bearer with invalid signature + valid id_token query → 401 (no fallback)', async () => {
    await createTestMerchant(SHOP_A);
    const badBearer = makeSessionToken(SHOP_A, { secret: 'a-completely-different-wrong-secret' });
    const validQuery = makeSessionToken(SHOP_A);

    const res = await invokeIndex(
      jwtRequest('/', { shop: SHOP_A, bearer: badBearer, idToken: validQuery }),
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body).toEqual({ error: 'session_token_invalid', reason: 'invalid_jwt' });
  });

  // -------------------------------------------------------------------------
  // L-4. Valid JWT + no Merchant row → 302 to /auth?shop=X&id_token=<JWT>
  // (Branch A re-bootstrap, idempotent — Q-B5).
  // -------------------------------------------------------------------------

  it('L-4. _index: valid JWT + NO Merchant → 302 to /auth?shop=X&id_token=<JWT> (Branch A re-bootstrap, Q-B5)', async () => {
    const token = makeSessionToken(SHOP_A);

    const res = await invokeIndex(jwtRequest('/', { shop: SHOP_A, bearer: token }));

    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toBe(
      `/auth?shop=${encodeURIComponent(SHOP_A)}&id_token=${encodeURIComponent(token)}`,
    );
  });

  // -------------------------------------------------------------------------
  // L-5. Invalid JWT (bad signature) → 401 JSON
  // -------------------------------------------------------------------------

  it('L-5. _index: invalid Bearer JWT (bad signature) → 401 JSON `{ reason: "invalid_jwt" }`', async () => {
    await createTestMerchant(SHOP_A);
    const token = makeSessionToken(SHOP_A, { secret: 'a-different-secret' });

    const res = await invokeIndex(jwtRequest('/', { shop: SHOP_A, bearer: token }));

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body).toEqual({ error: 'session_token_invalid', reason: 'invalid_jwt' });
  });

  // -------------------------------------------------------------------------
  // L-6. Cross-shop replay (JWT dest=A, query.shop=B) → 401 wrong_dest
  // -------------------------------------------------------------------------

  it('L-6. _index: cross-shop replay — JWT dest=A, query.shop=B → 401 `{ reason: "wrong_dest" }`', async () => {
    await createTestMerchant(SHOP_B);
    const token = makeSessionToken(SHOP_A); // dest=SHOP_A

    const res = await invokeIndex(jwtRequest('/', { shop: SHOP_B, bearer: token }));

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body).toEqual({ error: 'session_token_invalid', reason: 'wrong_dest' });
  });

  // -------------------------------------------------------------------------
  // L-7. JWT present but no ?shop query → 400
  // -------------------------------------------------------------------------

  it('L-7. _index: Bearer JWT present but no ?shop query → 400 (no anchor for cross-shop verification)', async () => {
    const token = makeSessionToken(SHOP_A);

    const res = await invokeIndex(jwtRequest('/', { bearer: token }));

    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // L-8. JWT path on /customers
  // -------------------------------------------------------------------------

  it('L-8. /customers: valid Bearer JWT + Merchant exists → 200 with rows + nextCursor', async () => {
    await createTestMerchant(SHOP_A);
    const token = makeSessionToken(SHOP_A);

    const res = await invokeCustomers(
      jwtRequest('/customers', { shop: SHOP_A, bearer: token }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      shop: string;
      rows: unknown[];
      nextCursor: string | null;
    };
    expect(body.shop).toBe(SHOP_A);
    expect(body.rows).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  // -------------------------------------------------------------------------
  // L-9. JWT path on /settings
  // -------------------------------------------------------------------------

  it('L-9. /settings: valid Bearer JWT + Merchant exists → 200 with settings fields', async () => {
    await createTestMerchant(SHOP_A);
    const token = makeSessionToken(SHOP_A);

    const res = await invokeSettings(
      jwtRequest('/settings', { shop: SHOP_A, bearer: token }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { attributionDirectWindowDays: number };
    expect(typeof body.attributionDirectWindowDays).toBe('number');
  });

  // -------------------------------------------------------------------------
  // L-10. Tenant isolation under the JWT path — two merchants, distinct
  // JWTs in parallel. Same ALS-leak detector as the legacy-path test
  // above, but exercised through the JWT verification entry.
  // -------------------------------------------------------------------------

  it('L-10. /settings: tenant isolation under JWT — two merchants in parallel, distinct loader returns', async () => {
    const idA = await createTestMerchant(SHOP_A);
    const idB = await createTestMerchant(SHOP_B);

    await withSystemScope('test.distinct_settings_jwt', async () => {
      await getTestClient().merchantSettings.update({
        where: { merchantId: idA },
        data: { attributionDirectWindowDays: 77 },
      });
      await getTestClient().merchantSettings.update({
        where: { merchantId: idB },
        data: { attributionDirectWindowDays: 33 },
      });
    });

    const tokenA = makeSessionToken(SHOP_A);
    const tokenB = makeSessionToken(SHOP_B);

    const [resA, resB] = await Promise.all([
      invokeSettings(jwtRequest('/settings', { shop: SHOP_A, bearer: tokenA })),
      invokeSettings(jwtRequest('/settings', { shop: SHOP_B, bearer: tokenB })),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const bodyA = (await resA.json()) as { attributionDirectWindowDays: number };
    const bodyB = (await resB.json()) as { attributionDirectWindowDays: number };
    expect(bodyA.attributionDirectWindowDays).toBe(77);
    expect(bodyB.attributionDirectWindowDays).toBe(33);
  });
});
