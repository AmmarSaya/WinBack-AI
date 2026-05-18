import { createHmac } from 'node:crypto';

import { generateState } from '../../app/services/auth-state.server.js';

/**
 * Produce a Shopify-style OAuth callback HMAC over a query record.
 *
 * MUST match the canonicalization in `verifyShopifyOAuthHmac` /
 * `canonicalizeQueryForHmac` at packages/shopify/src/hmac.ts (see lines
 * 71-83). The contract:
 *   - Exclude `hmac` and `signature` keys.
 *   - Skip undefined values.
 *   - Sort entries lexicographically by key.
 *   - Multi-valued keys → comma-join.
 *   - Join `k=v` pairs with `&` (no URL encoding — Shopify signs the
 *     decoded values).
 *   - HMAC-SHA256, **hex** encoding (NOT base64 — webhooks are base64,
 *     OAuth callbacks are hex; the two diverge intentionally).
 *
 * If `canonicalizeQueryForHmac` changes shape, the signed hex here will no
 * longer match production verification — tests fail loudly with 401, NOT
 * silently — which is the intended failure mode.
 */
export function signOauthCallback(
  query: Record<string, string>,
  secret: string,
): string {
  const entries = Object.entries(query)
    .filter(([k, v]) => k !== 'hmac' && k !== 'signature' && v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const message = entries.map(([k, v]) => `${k}=${v}`).join('&');
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

export interface BuildOauthCallbackArgs {
  readonly shop: string;
  readonly code: string;
  readonly host?: string;
  readonly timestamp?: string;
  readonly secret: string;
  /** Override HMAC for invalid-HMAC tests. */
  readonly hmacOverride?: string;
  /** Override state for state-mismatch tests. */
  readonly stateOverride?: string;
  /** Drop the state cookie for missing-cookie tests. */
  readonly omitCookie?: boolean;
  /** Drop the state query param for missing-state tests. */
  readonly omitState?: boolean;
  /** Drop the code query param for missing-code tests. */
  readonly omitCode?: boolean;
}

export interface BuildOauthCallbackResult {
  readonly request: Request;
  readonly state: string;
  readonly cookieHeader: string;
}

/**
 * Build a Request that mirrors what Shopify hits `/auth/callback` with,
 * including a valid CSRF state cookie produced by the SAME `generateState`
 * function production uses at `/auth`. This guarantees the cookie format
 * matches production exactly — if `generateState` changes its serialization,
 * tests detect it.
 *
 * The HMAC is computed over the final query (minus `hmac`), so adding
 * params (e.g. `host`) updates the signature automatically.
 */
export function buildOauthCallbackRequest(
  args: BuildOauthCallbackArgs,
): BuildOauthCallbackResult {
  const generated = generateState(args.shop, args.secret);
  const stateForUrl = args.stateOverride ?? generated.state;

  const query: Record<string, string> = {
    shop: args.shop,
    timestamp: args.timestamp ?? String(Math.floor(Date.now() / 1000)),
  };
  if (!args.omitCode) query.code = args.code;
  if (!args.omitState) query.state = stateForUrl;
  if (args.host !== undefined) query.host = args.host;

  // hmac is set on `query` here only so it ends up on the URL; signOauthCallback's
  // filter excludes it from canonicalization, so the signed message stays correct.
  query.hmac = args.hmacOverride ?? signOauthCallback(query, args.secret);

  const url = new URL('https://test.invalid/auth/callback');
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, v);
  }

  const headers = new Headers();
  if (!args.omitCookie) {
    headers.set('cookie', generated.cookieHeader);
  }

  return {
    request: new Request(url.toString(), { method: 'GET', headers }),
    state: generated.state,
    cookieHeader: generated.cookieHeader,
  };
}

/**
 * Build a Request for the OAuth install initiator `/auth?shop=...`.
 * Minimal — no cookie, no HMAC, just the query param.
 */
export function buildOauthInstallRequest(args: {
  readonly shop?: string;
}): Request {
  const url = new URL('https://test.invalid/auth');
  if (args.shop !== undefined) {
    url.searchParams.set('shop', args.shop);
  }
  return new Request(url.toString(), { method: 'GET' });
}
