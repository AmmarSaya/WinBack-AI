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
 * ─── COEXISTENCE PATH (Phase 1 Q-B2) ────────────────────────────────
 *
 * When neither Bearer header nor `?id_token` is present but `?shop`
 * is, the helper still performs the legacy shop-based Merchant
 * lookup and redirects missing installs to `/auth?shop=X`. This
 * preserves the pre-M-8 behavior for cold-URL navigation during the
 * coexistence window. Commit 4 (separate session) will re-aim the
 * redirect target when the legacy code-grant path is removed.
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
 *   - `debug { shop }         session_auth: legacy shop-only path (no JWT)`
 *   - `warn  { shop, reason } session_auth: JWT invalid`
 *
 * Commit 4 (legacy code-grant deletion) is safe to ship once the
 * "legacy shop-only" debug rate drops to near-zero across active
 * merchants.
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

  if (authHeader !== null && authHeader.startsWith('Bearer ')) {
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

  // `shop` is required regardless of which path runs — without it we
  // can't verify cross-shop replay (JWT path) and can't construct the
  // redirect target (legacy path).
  if (shop === null) {
    throw new Response('Missing shop', { status: 400 });
  }

  if (sessionToken === null) {
    // Legacy ?shop-only path (coexistence). Code-grant fires on miss.
    log.debug({ shop }, 'session_auth: legacy shop-only path (no JWT)');
    return await lookupMerchantOrRedirect(
      shop,
      scopeReason,
      host,
      `/auth?shop=${encodeURIComponent(shop)}`,
    );
  }

  // JWT path.
  try {
    await decodeAndVerifySessionToken(sessionToken, shop);
  } catch (err) {
    const reason =
      err instanceof ShopifySessionTokenError ? err.reason : 'invalid_jwt';
    log.warn({ shop, reason }, 'session_auth: JWT invalid');
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
    throw redirect(redirectIfMissing);
  }

  return {
    merchantId: merchant.id,
    shop: merchant.shop,
    installedAt: merchant.installedAt,
    host,
  };
}
