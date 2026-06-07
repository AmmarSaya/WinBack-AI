/**
 * B3 on-the-wire smoke test — proves the production entry.server.tsx's
 * default export calls setSecurityHeaders. The 10 helper-level unit
 * tests live at apps/web/tests/security-headers.test.ts; this single
 * integration test proves the helper is wired into handleRequest,
 * not just that it works in isolation.
 *
 * Lives under tests/integration/ because importing entry.server.tsx
 * triggers boot-time `getCoreConfig()` + `getShopifyConfig()` (lines
 * 24-25), which require the Shopify env vars the integration runner
 * injects via scripts/web-test.mjs. The unit test runner does not.
 *
 * setSecurityHeaders runs synchronously at the top of handleRequest
 * BEFORE either render path (bot or browser) begins. We launch the
 * render Promise and immediately inspect the Headers object — the
 * mutations have already happened. The render Promise itself will
 * reject with the empty EntryContext mock; we drain it to avoid an
 * unhandled-rejection warning but don't care about the outcome.
 */

import type { AppLoadContext, EntryContext } from '@remix-run/node';
import { describe, expect, it } from 'vitest';

describe('handleRequest wiring — security headers arrive on the response Headers (B3 on-the-wire smoke)', () => {
  it('CSP + nosniff + Referrer-Policy are set on responseHeaders synchronously, before render begins', async () => {
    // Dynamic import so the boot-time config validation triggers under
    // the integration runner's env-injected scope (not at file-load).
    const mod = await import('../../app/entry.server.js');
    const handleRequest = mod.default;

    const request = new Request(
      'https://winback-ai-web.onrender.com/?shop=foo.myshopify.com',
    );
    const responseHeaders = new Headers();

    const renderPromise = handleRequest(
      request,
      200,
      responseHeaders,
      {} as EntryContext,
      {},
    );

    // Headers populated before any await — setSecurityHeaders runs
    // synchronously at the top of handleRequest. The empty mocks
    // cause the render itself to fail; we don't care.
    expect(responseHeaders.get('Content-Security-Policy')).toContain(
      'https://foo.myshopify.com',
    );
    expect(responseHeaders.get('Content-Security-Policy')).toContain(
      'https://admin.shopify.com',
    );
    expect(responseHeaders.get('X-Content-Type-Options')).toBe('nosniff');
    expect(responseHeaders.get('Referrer-Policy')).toBe(
      'strict-origin-when-cross-origin',
    );
    expect(responseHeaders.has('X-Frame-Options')).toBe(false);

    await renderPromise.catch(() => undefined);
  });
});
