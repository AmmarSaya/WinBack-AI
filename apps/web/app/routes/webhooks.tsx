import type { ActionFunctionArgs } from '@remix-run/node';
import { toHttp } from '@winback/errors';
import { getLogger } from '@winback/logger';

import { getPrisma } from '~/services/db.server.js';
import { withRequest } from '~/services/request-context.server.js';
import { ingestWebhook } from '~/services/webhook-ingest.server.js';

const log = getLogger('web.webhooks.route');

/**
 * POST /webhooks
 *
 * Single endpoint for all Shopify webhook topics. Configure ONE delivery
 * URL in the Shopify Partner dashboard; topic is dispatched from the
 * `X-Shopify-Topic` header.
 *
 * STRICT BOUNDARY (locked at C3, enforced here):
 *   - Read raw body via `request.text()` BEFORE any JSON parsing —
 *     Shopify HMAC is over exact bytes.
 *   - HMAC verify before any DB access (in ingestWebhook).
 *   - Single tx for IdempotencyKey + WebhookLog + OutboxEvent.
 *   - Return 200 within Shopify's 5-second budget.
 *   - NO business logic. The outbox drainer (D2) does the work.
 */
export async function action({ request }: ActionFunctionArgs) {
  return withRequest(request, async () => {
    // CRITICAL: raw body first. Any middleware that auto-parses JSON would
    // break HMAC verification (computed over exact bytes Shopify sent).
    const rawBody = await request.text();

    const topic = request.headers.get('x-shopify-topic');
    const shop = request.headers.get('x-shopify-shop-domain');
    const webhookId = request.headers.get('x-shopify-webhook-id');
    const hmac = request.headers.get('x-shopify-hmac-sha256');

    let outcome;
    try {
      outcome = await ingestWebhook(getPrisma(), {
        topic,
        shop,
        webhookId,
        hmac,
        rawBody,
      });
    } catch (err) {
      // Ingestion error AFTER HMAC passed — DB or unknown failure. Return
      // 5xx so Shopify retries. The atomic tx in ingestWebhook means no
      // IdempotencyKey was written, so retry is clean (not double-processed).
      //
      // Body shape comes from @winback/errors `toHttp`. Shopify itself
      // ignores the body, but the JSON envelope is what shows up in our
      // logs / operator dashboards and what D2 worker error-surfacing
      // will compose against. The contract is tested in
      // packages/errors/tests/http.test.ts; loosening it requires a
      // paired update there.
      log.error({ err, topic, shop, webhookId }, 'webhook handler caught');
      const { status, body } = toHttp(err, { safeMessage: 'webhook handler failure' });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (outcome.kind === 'reject') {
      log.warn(
        { topic, shop, webhookId, reason: outcome.reason },
        `webhook rejected (${outcome.status})`,
      );
      return new Response(outcome.reason, { status: outcome.status });
    }

    return new Response('ok', {
      status: 200,
      headers: { 'X-Winback-Webhook-Outcome': outcome.reason },
    });
  });
}

/**
 * GET /webhooks — returns 200 OK to satisfy Shopify Compliance Webhook
 * validation probes. The Partners Dashboard tests the GDPR webhook URLs
 * with a non-POST request before accepting them; if the endpoint 405s,
 * the dashboard refuses the save and surfaces the response body verbatim
 * as the validation error.
 *
 * Originally this loader returned 405 ("webhook endpoint accepts POST
 * only") under the assumption that Shopify only sends POST. That's true
 * for webhook DELIVERY but not for compliance VALIDATION probes.
 * Discovered during Partners Dashboard configuration on 2026-05-22 (the
 * operator-side step paired with the subscribe-side I-1 fix in
 * `bc5a61e`); see POINTS-TO-CONSIDER.md I-1 entry for the full two-
 * artifact resolution.
 *
 * The body is human-friendly diagnostic for someone curling the URL
 * during incident response — they get a clear signal that the endpoint
 * is healthy AND that POST is the operational interface.
 *
 * Cache-Control: no-store prevents Render's edge cache (or any
 * intermediary) from holding a stale response if this handler ever
 * changes again. Same pattern as `healthz.tsx` / `readyz.tsx`.
 */
export function loader() {
  return new Response('webhook endpoint ready (POST to deliver)', {
    status: 200,
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
  });
}
