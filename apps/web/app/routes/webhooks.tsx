import type { ActionFunctionArgs } from '@remix-run/node';
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
      // 500 so Shopify retries. The atomic tx in ingestWebhook means no
      // IdempotencyKey was written, so retry is clean (not double-processed).
      log.error({ err, topic, shop, webhookId }, 'webhook handler 500');
      return new Response('internal error', { status: 500 });
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
 * GET /webhooks — return 405 so misconfigured probes get a clear signal.
 * Shopify only sends POST; anything else is a configuration error.
 */
export function loader() {
  return new Response('webhook endpoint accepts POST only', {
    status: 405,
    headers: { Allow: 'POST' },
  });
}
