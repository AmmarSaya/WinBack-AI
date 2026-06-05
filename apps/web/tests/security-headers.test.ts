/**
 * B3 helper unit tests — CSP frame-ancestors + the static security
 * headers, plus the structural negative-test that X-Frame-Options is
 * NOT added (it would break embedded admin iframes).
 *
 * Helper-level only (no Shopify env required). The on-the-wire smoke
 * test that proves entry.server.tsx wires the helper into handleRequest
 * lives at `apps/web/tests/integration/security-headers.test.ts` — that
 * import triggers boot-time `getShopifyConfig()` which needs env vars
 * the integration runner injects via scripts/web-test.mjs.
 */

import { describe, expect, it } from 'vitest';

import { setSecurityHeaders } from '../app/services/security-headers.server.js';

// ---------------------------------------------------------------------------
// 1. setSecurityHeaders — pure helper unit tests
// ---------------------------------------------------------------------------

function applyHeadersFor(url: string): Headers {
  const headers = new Headers();
  setSecurityHeaders(new Request(url), headers);
  return headers;
}

describe('setSecurityHeaders (B3 / closes L2-H2, L2-M2)', () => {
  it('CSP contains the requesting shop + the 4 Shopify entries (verbatim @shopify/shopify-app-remix 3.8.1 list) when ?shop is valid', () => {
    const csp = applyHeadersFor(
      'https://winback-ai-web.onrender.com/?shop=foo.myshopify.com',
    ).get('Content-Security-Policy');

    // Byte-exact match against the SDK's emitted string (with the shop
    // substituted in and the trailing `;` preserved). If the SDK's list
    // drifts (e.g. they add a 5th internal domain at v4+), this
    // assertion catches it and we update in lockstep — see the file-
    // header comment in security-headers.server.ts.
    expect(csp).toBe(
      "frame-ancestors https://foo.myshopify.com " +
        "https://admin.shopify.com " +
        "https://*.spin.dev " +
        "https://admin.myshopify.io " +
        "https://admin.shop.dev;",
    );
  });

  it("CSP = frame-ancestors 'none' when ?shop is missing (strict deny — divergence from SDK which omits)", () => {
    expect(
      applyHeadersFor('https://winback-ai-web.onrender.com/').get(
        'Content-Security-Policy',
      ),
    ).toBe("frame-ancestors 'none';");
  });

  it("CSP = frame-ancestors 'none' when ?shop is a non-myshopify.com host (evil.com)", () => {
    expect(
      applyHeadersFor('https://winback-ai-web.onrender.com/?shop=evil.com').get(
        'Content-Security-Policy',
      ),
    ).toBe("frame-ancestors 'none';");
  });

  it("CSP = frame-ancestors 'none' when ?shop is foo.example.com (wrong TLD)", () => {
    expect(
      applyHeadersFor(
        'https://winback-ai-web.onrender.com/?shop=foo.example.com',
      ).get('Content-Security-Policy'),
    ).toBe("frame-ancestors 'none';");
  });

  it("CSP = frame-ancestors 'none' on a subdomain attack (evil.myshopify.com.attacker.com)", () => {
    // The `$` anchor in isValidShopDomain's regex rejects this — the
    // domain ends with `.attacker.com`, not `.myshopify.com`. Confirming
    // the anchor holds at the CSP entry point too (defense in depth).
    expect(
      applyHeadersFor(
        'https://winback-ai-web.onrender.com/?shop=evil.myshopify.com.attacker.com',
      ).get('Content-Security-Policy'),
    ).toBe("frame-ancestors 'none';");
  });

  it("CSP = frame-ancestors 'none' on a leading-hyphen handle (-foo.myshopify.com)", () => {
    expect(
      applyHeadersFor(
        'https://winback-ai-web.onrender.com/?shop=-foo.myshopify.com',
      ).get('Content-Security-Policy'),
    ).toBe("frame-ancestors 'none';");
  });

  it("CSP = frame-ancestors 'none' on an empty ?shop value", () => {
    expect(
      applyHeadersFor('https://winback-ai-web.onrender.com/?shop=').get(
        'Content-Security-Policy',
      ),
    ).toBe("frame-ancestors 'none';");
  });

  it('X-Content-Type-Options: nosniff is present on every response (shop or no shop)', () => {
    expect(
      applyHeadersFor(
        'https://winback-ai-web.onrender.com/?shop=foo.myshopify.com',
      ).get('X-Content-Type-Options'),
    ).toBe('nosniff');
    expect(
      applyHeadersFor('https://winback-ai-web.onrender.com/').get(
        'X-Content-Type-Options',
      ),
    ).toBe('nosniff');
  });

  it('Referrer-Policy: strict-origin-when-cross-origin is present on every response', () => {
    expect(
      applyHeadersFor(
        'https://winback-ai-web.onrender.com/?shop=foo.myshopify.com',
      ).get('Referrer-Policy'),
    ).toBe('strict-origin-when-cross-origin');
    expect(
      applyHeadersFor('https://winback-ai-web.onrender.com/').get(
        'Referrer-Policy',
      ),
    ).toBe('strict-origin-when-cross-origin');
  });

  it('NEGATIVE: X-Frame-Options is NOT set on a shop-present request — CSP frame-ancestors supersedes; X-Frame-Options would break embedding', () => {
    const headers = applyHeadersFor(
      'https://winback-ai-web.onrender.com/?shop=foo.myshopify.com',
    );
    expect(headers.get('X-Frame-Options')).toBeNull();
    // Belt and suspenders — assert the key is genuinely absent, not
    // just null-valued.
    expect(headers.has('X-Frame-Options')).toBe(false);
  });

  it('NEGATIVE: X-Frame-Options is NOT set on a shop-absent request either', () => {
    const headers = applyHeadersFor('https://winback-ai-web.onrender.com/');
    expect(headers.get('X-Frame-Options')).toBeNull();
    expect(headers.has('X-Frame-Options')).toBe(false);
  });
});

