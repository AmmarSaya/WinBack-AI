import { createHmac } from 'node:crypto';

/**
 * Produce a Shopify-style webhook HMAC: base64(HMAC-SHA256(rawBody, secret)).
 * Matches what `verifyShopifyWebhookHmac` in @winback/shopify expects.
 */
export function signWebhook(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

export interface BuildWebhookRequestArgs {
  readonly topic: string;
  readonly shop: string;
  readonly webhookId: string;
  readonly body: unknown;
  readonly secret: string;
  /** Override the HMAC for invalid-HMAC tests. */
  readonly hmacOverride?: string;
  /** Omit headers for missing-header tests. */
  readonly omit?: ReadonlySet<'topic' | 'shop' | 'webhookId' | 'hmac'>;
}

/**
 * Build a Request that looks like what Shopify POSTs to /webhooks.
 * Body is stringified to deterministic JSON (HMAC is over exact bytes).
 */
export function buildWebhookRequest(args: BuildWebhookRequestArgs): Request {
  const rawBody = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
  const omit = args.omit ?? new Set();
  const headers = new Headers({ 'content-type': 'application/json' });
  if (!omit.has('topic')) headers.set('x-shopify-topic', args.topic);
  if (!omit.has('shop')) headers.set('x-shopify-shop-domain', args.shop);
  if (!omit.has('webhookId')) headers.set('x-shopify-webhook-id', args.webhookId);
  if (!omit.has('hmac')) {
    headers.set(
      'x-shopify-hmac-sha256',
      args.hmacOverride ?? signWebhook(rawBody, args.secret),
    );
  }
  return new Request('https://test.invalid/webhooks', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}
