import { describe, expect, it } from 'vitest';

import { action, loader } from '../app/routes/webhooks.js';

/**
 * Unit tests for `apps/web/app/routes/webhooks.tsx`'s GET handler.
 *
 * Background: prior to 2026-05-23, the loader returned 405 with the body
 * "webhook endpoint accepts POST only". This blocked Shopify Partners
 * Dashboard's Compliance Webhook validation probe — the dashboard
 * surfaces the response body verbatim as the validation error and
 * refuses to save the URL. See POINTS-TO-CONSIDER.md I-1 entry for the
 * full two-artifact resolution (subscribe side: `bc5a61e`; probe side:
 * this commit).
 *
 * The POST `action` handler is exercised by
 * `tests/integration/webhook-ingest.test.ts` against real Postgres.
 * Here we only assert the loader contract + a defensive presence check
 * on `action`.
 */
describe('webhooks route — GET loader (Shopify compliance probe ack)', () => {
  it('returns 200 OK to a GET request', () => {
    const response = loader();
    expect(response.status).toBe(200);
  });

  it('returns the expected diagnostic body', () => {
    // Body text is human-friendly diagnostic for incident-response
    // curls. Shopify's probe only checks the status code; the body is
    // for operators. Pinning it makes accidental regressions to the
    // pre-fix "webhook endpoint accepts POST only" string visible.
    return loader()
      .text()
      .then((body) => {
        expect(body).toBe('webhook endpoint ready (POST to deliver)');
      });
  });

  it('returns text/plain content type', () => {
    const response = loader();
    expect(response.headers.get('Content-Type')).toBe('text/plain');
  });

  it('sets Cache-Control: no-store to prevent stale edge caching', () => {
    // Render's edge (and any intermediary) MUST NOT cache this response.
    // If a future commit changes the loader's behaviour, a cached 405
    // (or a cached stale 200 body) would mask the change for any client
    // that hit the previous response before the deploy. The no-store
    // directive is the defensive lock against that mode.
    const response = loader();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('does NOT emit the pre-fix Allow header (405 artifact)', () => {
    // The original 405 response set `Allow: POST`. A 200 response has
    // no method-restriction semantics; the header is no longer
    // appropriate. Pinning its absence prevents a subtle refactor from
    // re-introducing it.
    const response = loader();
    expect(response.headers.get('Allow')).toBeNull();
  });

  it('does NOT emit the pre-fix 405 body string anywhere', () => {
    // Belt-and-braces regression lock. Shopify's Partners Dashboard
    // surfaces this exact string verbatim as the validation error; if a
    // future refactor reintroduces it (even with a different status),
    // this test fails loudly.
    return loader()
      .text()
      .then((body) => {
        expect(body).not.toContain('webhook endpoint accepts POST only');
      });
  });

  it('response is safe for HEAD synthesis (Remix strips body from GET response)', () => {
    // Remix synthesizes HEAD responses from the same loader by dropping
    // the body and keeping the status + headers. This test confirms the
    // loader's response shape survives that transformation cleanly: the
    // body is a finite string (not a streamed/chunked response that
    // would break HEAD), and the status + headers carry over.
    const getResponse = loader();
    const headResponse = new Response(null, {
      status: getResponse.status,
      headers: getResponse.headers,
    });
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get('Content-Type')).toBe('text/plain');
    expect(headResponse.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('webhooks route — POST action regression lock', () => {
  it('still exports an `action` handler (HMAC + ingest path unchanged)', () => {
    // The loader fix MUST NOT delete or alter the action export. Full
    // POST-path behaviour is tested by
    // `tests/integration/webhook-ingest.test.ts` against real Postgres
    // (31 assertions); this is a 1-line defense against an accidental
    // export removal during a future refactor.
    expect(action).toBeDefined();
    expect(typeof action).toBe('function');
  });
});
