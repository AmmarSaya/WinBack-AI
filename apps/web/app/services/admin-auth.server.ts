import { json, redirect } from '@remix-run/node';
import { type SystemScopeReason } from '@winback/contracts';
import { withSystemScope } from '@winback/db';
import { getLogger } from '@winback/logger';
import {
  ShopifySessionTokenError,
  decodeAndVerifySessionToken,
  normalizeShopDomain,
} from '@winback/shopify';

import { getPrisma } from './db.server.js';

const log = getLogger('web.session_auth');

export interface AdminAuthContext {
  readonly merchantId: string;
  readonly shop: string;
  readonly installedAt: Date;
  /**
   * App Bridge `host` query param, opaque to us. Empty string when
   * absent — keeps the type simple; loaders that need it can treat the
   * empty string as "missing" without a nullable branch.
   */
  readonly host: string;
}

/**
 * Gate every admin loader/action behind shop validation + (optionally)
 * session-token JWT verification. Throws `Response` on failure (Remix
 * idiom; matches `_index.tsx`'s pre-helper pattern).
 *
 * ─── JWT SOURCE ORDERING (Phase 1 Q-B1) ─────────────────────────────
 *
 * `Authorization: Bearer <JWT>` header preferred; `?id_token=<JWT>`
 * query as fallback. The key security property — locked by L-3b in
 * the integration suite — is that a PRESENT-BUT-INVALID Bearer header
 * does NOT fall back to query. A "client committed to header-strict
 * semantics by sending Bearer" interpretation: if the header is
 * present with a non-empty Bearer value, that token is verified and
 * any failure surfaces as 401, even when a valid query token is
 * available. Otherwise a downgrade attacker could send a known-bad
 * header + a forged query token and hope the server tries each
 * source in turn.
 *
 * Edge cases that DON'T trigger header-strict mode (and therefore
 * fall through to the query fallback):
 *   - `Authorization: Bearer ` (empty token after trim) — the client
 *     didn't actually present a credential.
 *   - `Authorization: Basic ...` (non-Bearer scheme) — different
 *     credential type, not in our protocol.
 *   - No `Authorization` header at all.
 *
 * ─── NO SESSION TOKEN → 401 (B4 / M-8 Commit 4) ─────────────────────
 *
 * When neither Bearer header nor `?id_token` query is present, the
 * helper rejects with 401 `session_token_required`. There is no
 * fallback to a shop-only Merchant lookup — the pre-B4 fallback was
 * the L2-H1 cross-tenant exploit (`?shop=victim.myshopify.com`
 * returning victim data) and is permanently closed. Embedded App
 * Bridge clients always present a session token; cold-URL navigation
 * by an operator must come through the embedded entry that issues one.
 *
 * ─── JWT VERIFIES BUT NO MERCHANT (Phase 1 Q-B5) ────────────────────
 *
 * Redirect to `/auth?shop=X&id_token=<JWT>` so Branch A's idempotent
 * Token Exchange bootstrap runs again. This recovers cleanly from
 * the rare race where Shopify issued a session token before the
 * install bootstrap finished (or where bootstrap failed after JWT
 * issuance).
 *
 * ─── ADOPTION TELEMETRY ─────────────────────────────────────────────
 *
 * Three log lines emitted for operator grepping:
 *   - `debug { source, shop } session_auth: JWT verified`
 *   - `warn  { shop }         session_auth: no session token presented` (→ 401)
 *   - `warn  { shop, reason } session_auth: JWT invalid` (→ 401)
 */
export async function requireAdminAuth(
  request: Request,
  scopeReason: SystemScopeReason,
): Promise<AdminAuthContext> {
  const url = new URL(request.url);
  const host = url.searchParams.get('host') ?? '';
  const queryShop = url.searchParams.get('shop');
  const shop = queryShop !== null ? normalizeShopDomain(queryShop) : null;

  // Resolve session token source — header preferred, query fallback.
  // See module docstring for header-strict / fallback semantics.
  const authHeader = request.headers.get('authorization');
  let sessionToken: string | null = null;
  let source: 'header' | 'query' | null = null;

  if (authHeader?.startsWith('Bearer ')) {
    const bearer = authHeader.slice('Bearer '.length).trim();
    if (bearer.length > 0) {
      sessionToken = bearer;
      source = 'header';
    }
  }
  if (sessionToken === null) {
    const queryToken = url.searchParams.get('id_token');
    if (queryToken !== null && queryToken.length > 0) {
      sessionToken = queryToken;
      source = 'query';
    }
  }

  // `shop` is required for cross-shop-replay verification: the JWT path
  // compares the token's `dest` against this. Without `shop` we can't
  // decide what we're verifying against.
  if (shop === null) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- Remix framework pattern: thrown Response routes to the route's ErrorBoundary; wrapping in `new Error()` would break the boundary contract.
    throw new Response('Missing shop', { status: 400 });
  }

  if (sessionToken === null) {
    // No Bearer header, no ?id_token query. Pre-B4 this fell through to
    // a shop-only Merchant lookup that returned victim data on attacker-
    // crafted ?shop= URLs (L2-H1). Permanently closed: 401, no DB lookup,
    // no shop disclosure beyond what the caller already supplied.
    log.warn({ shop }, 'session_auth: no session token presented');
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- Remix framework pattern: thrown json() Response routes to the route's ErrorBoundary; wrapping in `new Error()` would break the boundary contract.
    throw json(
      { error: 'session_token_required', reason: 'no_token' },
      { status: 401 },
    );
  }

  // JWT path.
  try {
    await decodeAndVerifySessionToken(sessionToken, shop);
  } catch (err) {
    const reason =
      err instanceof ShopifySessionTokenError ? err.reason : 'invalid_jwt';
    log.warn({ shop, reason }, 'session_auth: JWT invalid');
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- Remix framework pattern: thrown json() Response routes to the route's ErrorBoundary; wrapping in `new Error()` would break the boundary contract.
    throw json(
      { error: 'session_token_invalid', reason },
      { status: 401 },
    );
  }

  log.debug({ source, shop }, 'session_auth: JWT verified');

  return await lookupMerchantOrRedirect(
    shop,
    scopeReason,
    host,
    `/auth?shop=${encodeURIComponent(shop)}&id_token=${encodeURIComponent(sessionToken)}`,
  );
}

async function lookupMerchantOrRedirect(
  shop: string,
  scopeReason: SystemScopeReason,
  host: string,
  redirectIfMissing: string,
): Promise<AdminAuthContext> {
  const merchant = await withSystemScope(scopeReason, async () => {
    return await getPrisma().merchant.findUnique({
      where: { shop },
      select: { id: true, shop: true, installedAt: true },
    });
  });

  if (merchant === null) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- Remix framework pattern: thrown redirect() routes through the framework's redirect path; wrapping in `new Error()` would break the redirect contract.
    throw redirect(redirectIfMissing);
  }

  return {
    merchantId: merchant.id,
    shop: merchant.shop,
    installedAt: merchant.installedAt,
    host,
  };
}
