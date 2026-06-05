import { normalizeShopDomain } from '@winback/shopify';

/**
 * Document-response security headers (B3 / closes L2-H2, L2-M2).
 *
 * Mutates the passed-in `Headers` object — called once per request from
 * `entry.server.tsx`'s `handleRequest` BEFORE either render path (bot or
 * browser) constructs its Response. Both render paths share this logic
 * so the bot and browser branches cannot drift.
 *
 * What gets set:
 *
 *   1. `Content-Security-Policy: frame-ancestors ...`
 *      Per-shop dynamic. Source-of-truth: the `?shop=` query param,
 *      validated through `@winback/shopify`'s `normalizeShopDomain`
 *      (which itself wraps `isValidShopDomain` — a real security control
 *      with anchored regex against the `.myshopify.com` domain, NOT a
 *      pure formatter).
 *
 *      Behavior split:
 *        - Valid shop  → full allowlist (see (a) below)
 *        - Absent shop → `frame-ancestors 'none';` (strict deny)
 *        - Invalid shop (rejected by `normalizeShopDomain`)
 *                      → `frame-ancestors 'none';` (strict deny)
 *
 *      The strict-deny on absent-shop is a DELIBERATE divergence from
 *      `@shopify/shopify-app-remix` 3.8.1, which omits CSP entirely in
 *      that case (see helpers/add-response-headers.js). L2-H2 is a
 *      clickjacking finding and 'none' costs nothing on a non-legit
 *      embedded request — more restrictive than the SDK is zero App
 *      Review risk.
 *
 *   2. `X-Content-Type-Options: nosniff`
 *      Defense against MIME confusion. Static, always present.
 *
 *   3. `Referrer-Policy: strict-origin-when-cross-origin`
 *      Modern default. Full Referer same-origin; origin-only on
 *      cross-origin HTTPS→HTTPS; nothing on HTTPS→HTTP downgrades.
 *      Embedded apps make cross-origin requests to Shopify; this
 *      leaks just the origin (no path), appropriate for SSO/CSRF.
 *
 *   4. **DELIBERATELY OMITTED: `X-Frame-Options`.**
 *      CSP frame-ancestors supersedes X-Frame-Options on modern
 *      browsers (per CSP Level 2 spec, X-Frame-Options is ignored
 *      when frame-ancestors is present). Setting
 *      `X-Frame-Options: SAMEORIGIN` would actively break embedding
 *      in non-modern browsers (admin.shopify.com framing this app);
 *      `DENY` would break it everywhere. The entry.server tests
 *      include a NEGATIVE assertion that this header is absent —
 *      do NOT add X-Frame-Options here.
 */

// =============================================================================
// (a) CSP frame-ancestors allowlist
//
// Verbatim match of @shopify/shopify-app-remix 3.8.1's
// helpers/add-response-headers.js line 17. The non-obvious entries
// (https://*.spin.dev, https://admin.myshopify.io, https://admin.shop.dev)
// are Shopify-internal dev/staging entrypoints that App Review tooling
// may iframe the app from — dropping any one of them can cause an
// App Review iframe to fail to render.
//
// Do NOT edit this list without checking the SDK version it was copied
// from. If you update the SDK and the canonical list changes, update
// here in lockstep.
//
// Source: node_modules/@shopify/shopify-app-remix/dist/cjs/server/
//         authenticate/helpers/add-response-headers.js (v3.8.1, line 17)
// =============================================================================
const SHOPIFY_INTERNAL_FRAME_ANCESTORS = [
  'https://admin.shopify.com',
  'https://*.spin.dev',
  'https://admin.myshopify.io',
  'https://admin.shop.dev',
] as const;

function buildCspWithShop(shop: string): string {
  // Trailing `;` matches the SDK's emitted string verbatim. Harmless
  // syntactically (CSP semicolons separate directives, trailing one
  // is well-formed) — keeping it identical to the SDK string makes
  // a future diff against an SDK upgrade trivially comparable.
  return `frame-ancestors https://${shop} ${SHOPIFY_INTERNAL_FRAME_ANCESTORS.join(' ')};`;
}

const CSP_FRAME_ANCESTORS_NONE = `frame-ancestors 'none';`;

// =============================================================================
// Public entry point
// =============================================================================

export function setSecurityHeaders(request: Request, headers: Headers): void {
  // CSP: per-shop dynamic.
  const rawShop = new URL(request.url).searchParams.get('shop');
  const shop = rawShop !== null ? normalizeShopDomain(rawShop) : null;
  headers.set(
    'Content-Security-Policy',
    shop !== null ? buildCspWithShop(shop) : CSP_FRAME_ANCESTORS_NONE,
  );

  // Static security headers — apply to every document response.
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Deliberate omission: X-Frame-Options. See file-header docstring.
}
