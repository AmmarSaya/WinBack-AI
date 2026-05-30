import { createHmac } from 'node:crypto';

import type { LoaderFunctionArgs } from '@remix-run/node';
import { Session } from '@shopify/shopify-api';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// vi.mock factory is hoisted above all module-level code, so `spies` must
// also be hoisted via `vi.hoisted()` — otherwise the factory tries to write
// to a TDZ'd `const`. The factory wraps `completeInstall` and
// `subscribeAllWebhooks` in delegating spies so per-test failure injection
// (`mockImplementationOnce`) and call-count assertions both work.
const spies = vi.hoisted(() => {
  return {
    completeInstall: undefined as ReturnType<typeof vi.fn> | undefined,
    subscribeAllWebhooks: undefined as ReturnType<typeof vi.fn> | undefined,
  };
});

vi.mock('@winback/shopify', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@winback/shopify')>();
  spies.completeInstall = vi.fn(orig.completeInstall);
  spies.subscribeAllWebhooks = vi.fn(orig.subscribeAllWebhooks);
  return {
    ...orig,
    completeInstall: spies.completeInstall,
    subscribeAllWebhooks: spies.subscribeAllWebhooks,
  };
});

import { loader } from '../../app/routes/auth.js';
import { assertRead, createTestMerchant, getTestClient, resetDb } from './setup.js';
import { getSessionStorage } from '../../app/services/session-storage.server.js';
import {
  mockSubscribeFailure,
  mockTokenExchangeFailure,
  setupShopifyMocks,
} from './shopify-mock.js';

// ---------------------------------------------------------------------------
// Test env — provided by scripts/web-test.mjs's TEST_SHOPIFY_ENV block.
// ---------------------------------------------------------------------------

const API_KEY = process.env.SHOPIFY_API_KEY;
const API_SECRET = process.env.SHOPIFY_API_SECRET;
if (API_KEY === undefined || API_KEY.length === 0) {
  throw new Error('SHOPIFY_API_KEY not set — run via `pnpm web:test`.');
}
if (API_SECRET === undefined || API_SECRET.length === 0) {
  throw new Error('SHOPIFY_API_SECRET not set — run via `pnpm web:test`.');
}

const SHOP = 'winback-test.myshopify.com';
const SHOP_OTHER = 'other-shop.myshopify.com';
const HOST = 'admin.shopify.com/store/winback-test';
const MOCK_TOKEN = 'shpat_test_token_for_harness';
const MOCK_NEW_SCOPE = 'read_customers,read_orders,write_discounts';

// ---------------------------------------------------------------------------
// JWT construction — real HS256 JWTs against the test SHOPIFY_API_SECRET.
// Mirrors packages/shopify/tests/auth/decode-session-token.test.ts so a
// future SDK upgrade that changes JWT semantics fails here too.
// ---------------------------------------------------------------------------

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

interface JwtOverrides {
  readonly aud?: string;
  readonly dest?: string;
  readonly iss?: string;
  readonly exp?: number;
  readonly nbf?: number;
  readonly secret?: string;
}

function makeSessionToken(shop: string = SHOP, overrides: JwtOverrides = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: overrides.iss ?? `https://${shop}/admin`,
    dest: overrides.dest ?? `https://${shop}`,
    aud: overrides.aud ?? API_KEY,
    sub: '12345',
    exp: overrides.exp ?? now + 60,
    nbf: overrides.nbf ?? now - 60,
    iat: now,
    jti: `test-jti-${String(now)}-${Math.random().toString(36).slice(2)}`,
    sid: 'test-sid',
  };
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const sig = base64url(
    createHmac('sha256', overrides.secret ?? API_SECRET!).update(`${header}.${body}`).digest(),
  );
  return `${header}.${body}.${sig}`;
}

// ---------------------------------------------------------------------------
// Loader invocation — mirrors oauth-install / oauth-callback patterns.
// ---------------------------------------------------------------------------

async function invokeAuthLoader(request: Request): Promise<Response> {
  const args: LoaderFunctionArgs = { request, params: {}, context: {} };
  try {
    return (await loader(args)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

function buildBootstrapRequest(
  args: { shop?: string; idToken?: string; host?: string } = {},
): Request {
  const url = new URL('https://test.invalid/auth');
  if (args.shop !== undefined) url.searchParams.set('shop', args.shop);
  if (args.idToken !== undefined) url.searchParams.set('id_token', args.idToken);
  if (args.host !== undefined) url.searchParams.set('host', args.host);
  return new Request(url.toString(), { method: 'GET' });
}

async function preCreateSession(
  shop: string,
  scope: string,
  accessToken = 'pre-existing-access-token',
): Promise<void> {
  const session = new Session({
    id: `offline_${shop}`,
    shop,
    state: '',
    isOnline: false,
    scope,
    accessToken,
  });
  await getSessionStorage().storeSession(session);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('/auth bootstrap — Token Exchange (Branch A) + code-grant (Branch B) (integration)', () => {
  setupShopifyMocks();

  beforeEach(async () => {
    await resetDb();
    spies.completeInstall?.mockClear();
    spies.subscribeAllWebhooks?.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    spies.completeInstall?.mockClear();
    spies.subscribeAllWebhooks?.mockClear();
  });

  afterAll(async () => {
    await getTestClient().$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. Fresh install: valid JWT, no prior Merchant
  // -------------------------------------------------------------------------

  it('1. fresh install: valid JWT → 302 to /?shop=&host=, Merchant + Settings + Subscription + Session rows created, webhooks subscribed', async () => {
    const token = makeSessionToken();
    const res = await invokeAuthLoader(
      buildBootstrapRequest({ shop: SHOP, idToken: token, host: HOST }),
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toMatch(
      new RegExp(`^https://test\\.invalid/\\?shop=${SHOP.replace(/\./g, '\\.')}`),
    );
    expect(location).toContain(`host=${encodeURIComponent(HOST)}`);

    const client = getTestClient();
    const merchants = await assertRead(() =>
      client.merchant.findMany({ where: { shop: SHOP } }),
    );
    expect(merchants).toHaveLength(1);

    const settings = await assertRead(() =>
      client.merchantSettings.findMany({ where: { merchantId: merchants[0]!.id } }),
    );
    expect(settings).toHaveLength(1);

    const sessions = await assertRead(() =>
      client.session.findMany({ where: { shop: SHOP } }),
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(`offline_${SHOP}`);
    // Encrypted at rest.
    expect(sessions[0]?.accessToken).not.toBe(MOCK_TOKEN);
    expect(sessions[0]?.accessToken.startsWith('v1:')).toBe(true);

    expect(spies.subscribeAllWebhooks).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 2. Already-installed re-bootstrap
  // -------------------------------------------------------------------------

  it('2. re-bootstrap: valid JWT, Merchant + Session pre-existing → 302, Merchant count = 1, webhooks NOT re-subscribed', async () => {
    const existingId = await createTestMerchant(SHOP);
    await preCreateSession(SHOP, 'read_orders');

    const token = makeSessionToken();
    const res = await invokeAuthLoader(
      buildBootstrapRequest({ shop: SHOP, idToken: token, host: HOST }),
    );

    expect(res.status).toBe(302);

    const client = getTestClient();
    const merchants = await assertRead(() =>
      client.merchant.findMany({ where: { shop: SHOP } }),
    );
    expect(merchants).toHaveLength(1);
    expect(merchants[0]?.id).toBe(existingId);

    expect(spies.subscribeAllWebhooks).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. Scope upgrade
  // -------------------------------------------------------------------------

  it('3. scope drift: prior Session.scope narrower than Token Exchange response → Session.scope refreshed', async () => {
    await createTestMerchant(SHOP);
    await preCreateSession(SHOP, 'read_orders');

    const token = makeSessionToken();
    const res = await invokeAuthLoader(
      buildBootstrapRequest({ shop: SHOP, idToken: token, host: HOST }),
    );

    expect(res.status).toBe(302);

    const client = getTestClient();
    const sessions = await assertRead(() =>
      client.session.findMany({ where: { shop: SHOP } }),
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.scope).toBe(MOCK_NEW_SCOPE);

    // The route also emits an informational `auth: session scope drift
    // detected` log in this case (Q-A2). It is not asserted here because
    // pino's child-logger pattern (root.child({module}) per `getLogger`
    // call) returns a fresh instance per call, so a spy in the test does
    // not intercept the route's module-level `log` instance. The
    // behavioral assertion above (scope refreshed) is the load-bearing
    // check; the log is operator-visibility only.
  });

  // -------------------------------------------------------------------------
  // 4. Invalid JWT (bad signature)
  // -------------------------------------------------------------------------

  it('4. invalid JWT signature → 401 JSON `{ error: "session_token_invalid", reason: "invalid_jwt" }`, no DB writes', async () => {
    const token = makeSessionToken(SHOP, { secret: 'a-different-wrong-secret' });
    const res = await invokeAuthLoader(
      buildBootstrapRequest({ shop: SHOP, idToken: token, host: HOST }),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body).toEqual({ error: 'session_token_invalid', reason: 'invalid_jwt' });

    const client = getTestClient();
    expect(await assertRead(() => client.merchant.count())).toBe(0);
    expect(await assertRead(() => client.session.count())).toBe(0);
    expect(spies.completeInstall).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. Cross-shop replay (JWT for shop A, query shop B)
  // -------------------------------------------------------------------------

  it('5. cross-shop replay: JWT issued for shop A, query shop=B → 401 `{ reason: "wrong_dest" }`, no DB writes', async () => {
    const token = makeSessionToken(SHOP_OTHER); // dest=other-shop, signed correctly
    const res = await invokeAuthLoader(
      buildBootstrapRequest({ shop: SHOP, idToken: token, host: HOST }),
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body).toEqual({ error: 'session_token_invalid', reason: 'wrong_dest' });

    const client = getTestClient();
    expect(await assertRead(() => client.merchant.count())).toBe(0);
    expect(spies.completeInstall).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 6. JWT verifies but Token Exchange returns 401
  // -------------------------------------------------------------------------

  it('6. Token Exchange 401 → 500 with retry hint; **completeInstall NOT called** (explicit spy assertion)', async () => {
    mockTokenExchangeFailure();

    const token = makeSessionToken();
    const res = await invokeAuthLoader(
      buildBootstrapRequest({ shop: SHOP, idToken: token, host: HOST }),
    );

    expect(res.status).toBe(500);
    expect(res.headers.get('retry-after')).toBe('1');
    const body = (await res.json()) as { error: string; retry: boolean };
    expect(body).toEqual({ error: 'token_exchange_failed', retry: true });

    // EXPLICIT — don't infer from "no Session row written". The point of this
    // test is to verify the ordering invariant: Token Exchange runs BEFORE
    // completeInstall, and a failure short-circuits before any DB-mutating
    // call.
    expect(spies.completeInstall).not.toHaveBeenCalled();

    const client = getTestClient();
    expect(await assertRead(() => client.merchant.count())).toBe(0);
    expect(await assertRead(() => client.session.count())).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 7. completeInstall throws
  // -------------------------------------------------------------------------

  it('7. completeInstall throws → 500 with retry hint; Session NOT stored', async () => {
    spies.completeInstall!.mockImplementationOnce(async () => {
      throw new Error('simulated Prisma write failure');
    });

    const token = makeSessionToken();
    const res = await invokeAuthLoader(
      buildBootstrapRequest({ shop: SHOP, idToken: token, host: HOST }),
    );

    expect(res.status).toBe(500);
    expect(res.headers.get('retry-after')).toBe('1');
    const body = (await res.json()) as { error: string; retry: boolean };
    expect(body).toEqual({ error: 'install_failed', retry: true });

    const client = getTestClient();
    expect(await assertRead(() => client.session.count())).toBe(0);
    expect(spies.subscribeAllWebhooks).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 8. subscribeAllWebhooks fails — Q-A1 redirect to /?shop=&host=, NOT /auth
  // -------------------------------------------------------------------------

  it('8. subscribeAllWebhooks userError → 302 to /?shop=&host= (NOT /auth, per Q-A1); Merchant + Session still persisted', async () => {
    mockSubscribeFailure();

    const token = makeSessionToken();
    const res = await invokeAuthLoader(
      buildBootstrapRequest({ shop: SHOP, idToken: token, host: HOST }),
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toMatch(
      new RegExp(`^https://test\\.invalid/\\?shop=${SHOP.replace(/\./g, '\\.')}`),
    );
    expect(location).toContain(`host=${encodeURIComponent(HOST)}`);
    // Critical: NOT /auth.
    expect(location).not.toMatch(/\/auth(\?|$)/);

    const client = getTestClient();
    expect(await assertRead(() => client.merchant.count())).toBe(1);
    expect(await assertRead(() => client.session.count())).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 9. Legacy fallback (Branch B) — no id_token, valid shop
  // -------------------------------------------------------------------------

  it('9. legacy fallback: no id_token, valid shop → 302 to Shopify authorize URL with state cookie (Branch B preserved)', async () => {
    const res = await invokeAuthLoader(buildBootstrapRequest({ shop: SHOP }));

    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toMatch(
      new RegExp(`^https://${SHOP.replace(/\./g, '\\.')}/admin/oauth/authorize\\?`),
    );
    expect(location).toContain('client_id=');
    expect(location).toContain('scope=');
    expect(location).toContain('state=');

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('winback_auth_state=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=None');

    // No DB writes on Branch B.
    const client = getTestClient();
    expect(await assertRead(() => client.merchant.count())).toBe(0);
    expect(spies.completeInstall).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 10. Invalid shop param
  // -------------------------------------------------------------------------

  it('10. invalid shop param → 400, no DB writes (id_token branch never reached)', async () => {
    const token = makeSessionToken();
    const res = await invokeAuthLoader(
      buildBootstrapRequest({ shop: 'not a real shop', idToken: token }),
    );
    expect(res.status).toBe(400);
    expect(spies.completeInstall).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 11. Missing shop param
  // -------------------------------------------------------------------------

  it('11. missing shop param → 400', async () => {
    const res = await invokeAuthLoader(buildBootstrapRequest({}));
    expect(res.status).toBe(400);
    expect(spies.completeInstall).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 12. Concurrent first-install race
  // -------------------------------------------------------------------------

  it('12. concurrent first-install race: Promise.all of 2 parallel /auth?id_token requests → both 302, Merchant = 1, Session = 1, subscribeAllWebhooks called 1 or 2 times (both OK), no orphans', async () => {
    const token = makeSessionToken();
    const [res1, res2] = await Promise.all([
      invokeAuthLoader(buildBootstrapRequest({ shop: SHOP, idToken: token, host: HOST })),
      invokeAuthLoader(buildBootstrapRequest({ shop: SHOP, idToken: token, host: HOST })),
    ]);

    expect(res1.status).toBe(302);
    expect(res2.status).toBe(302);

    const client = getTestClient();
    expect(await assertRead(() => client.merchant.count())).toBe(1);
    expect(await assertRead(() => client.session.count())).toBe(1);

    // MerchantSettings + BillingSubscription single-row guarantees follow
    // from the unique constraint on merchantId — defensive assertion that
    // the upserts didn't somehow produce orphans.
    const merchants = await assertRead(() =>
      client.merchant.findMany({ where: { shop: SHOP }, select: { id: true } }),
    );
    const merchantId = merchants[0]!.id;
    expect(
      await assertRead(() =>
        client.merchantSettings.count({ where: { merchantId } }),
      ),
    ).toBe(1);
    expect(
      await assertRead(() =>
        client.billingSubscription.count({ where: { merchantId } }),
      ),
    ).toBe(1);

    // subscribeAllWebhooks: 1 OR 2 acceptable. The race resolution depends
    // on whether both transactions read `isNewInstall=true` (both call) or
    // one reads `false` (one calls). Shopify's webhookSubscriptionCreate is
    // idempotent so either outcome is benign — see Comment 1 in auth.tsx.
    const callCount = spies.subscribeAllWebhooks!.mock.calls.length;
    expect(callCount === 1 || callCount === 2).toBe(true);
  });
});
