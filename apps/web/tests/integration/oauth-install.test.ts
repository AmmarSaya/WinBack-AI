import type { LoaderFunctionArgs } from '@remix-run/node';
import { describe, expect, it } from 'vitest';

import { loader } from '../../app/routes/auth.js';

import { buildOauthInstallRequest } from './sign-oauth.js';

/**
 * `/auth` is loader-only, no DB. These tests live in the integration suite
 * (not the unit suite) because they exercise the production loader against
 * the real config / Shopify-lib boundary — catching, e.g., env-validation
 * regressions or `buildAuthRedirectUrl` shape changes.
 */

async function invokeAuthLoader(request: Request): Promise<Response> {
  const args: LoaderFunctionArgs = { request, params: {}, context: {} };
  try {
    return (await loader(args)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

describe('/auth install initiator (integration)', () => {
  it('valid shop → 302 to Shopify authorize URL with state cookie', async () => {
    const res = await invokeAuthLoader(
      buildOauthInstallRequest({ shop: 'winback-test.myshopify.com' }),
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).not.toBeNull();
    expect(location).toMatch(
      /^https:\/\/winback-test\.myshopify\.com\/admin\/oauth\/authorize\?/,
    );
    expect(location).toContain('client_id=');
    expect(location).toContain('scope=');
    expect(location).toContain('state=');
    expect(location).toContain('redirect_uri=');

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain('winback_auth_state=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    // SameSite=None (NOT Lax) required for the cookie to survive Shopify's
    // OAuth redirect chain inside the admin.shopify.com iframe. See the
    // serializeStateCookie comment in apps/web/app/services/auth-state.server.ts
    // for the full rationale.
    expect(setCookie).toContain('SameSite=None');
    expect(setCookie).not.toContain('SameSite=Lax');
  });

  it('missing shop param → 400', async () => {
    const res = await invokeAuthLoader(buildOauthInstallRequest({}));
    expect(res.status).toBe(400);
  });

  it('invalid shop domain → 400', async () => {
    const res = await invokeAuthLoader(
      buildOauthInstallRequest({ shop: 'not a real shop domain' }),
    );
    expect(res.status).toBe(400);
  });
});
