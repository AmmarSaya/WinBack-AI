import type { ActionFunctionArgs } from '@remix-run/node';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { action } from '../../app/routes/webhooks.js';

import { assertRead, createTestMerchant, getTestClient, resetDb } from './setup.js';
import { buildWebhookRequest } from './sign-webhook.js';

// Read the secret from env (set by scripts/web-test.mjs) rather than
// duplicating the literal. Fail fast if absent so a bare `vitest run`
// doesn't produce confusing 401s — running the harness without the
// orchestrator is the only way SHOPIFY_API_SECRET would be unset here.
const SECRET = process.env.SHOPIFY_API_SECRET;
if (SECRET === undefined || SECRET.length === 0) {
  throw new Error(
    'SHOPIFY_API_SECRET not set — run via `pnpm web:test`, not bare vitest.',
  );
}
const SHOP = 'winback-test.myshopify.com';

async function invokeWebhook(request: Request): Promise<Response> {
  // Type the args explicitly. `params` and `context` are unused by this
  // action but required by Remix's signature. Empty defaults are safe.
  const args: ActionFunctionArgs = { request, params: {}, context: {} };
  return (await action(args));
}

describe('webhook ingest (integration, real Postgres)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await getTestClient().$disconnect();
  });

  it('valid orders/create paid → 200, writes WebhookLog + OutboxEvent', async () => {
    const merchantId = await createTestMerchant(SHOP);

    const res = await invokeWebhook(
      buildWebhookRequest({
        topic: 'orders/create',
        shop: SHOP,
        webhookId: 'wh-orders-create-1',
        body: { id: 1234567890, financial_status: 'paid' },
        secret: SECRET,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Winback-Webhook-Outcome')).toBe('processed');

    const client = getTestClient();
    const logs = await assertRead(() =>
      client.webhookLog.findMany({ where: { shopifyWebhookId: 'wh-orders-create-1' } }),
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      merchantId,
      shop: SHOP,
      topic: 'orders/create',
      hmacOk: true,
      status: 'processed',
    });

    const events = await assertRead(() =>
      client.outboxEvent.findMany({ where: { merchantId, type: 'order.placed' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      topic: 'orders/create',
      webhookId: 'wh-orders-create-1',
    });

    const idemp = await assertRead(() =>
      client.idempotencyKey.findMany({
        where: { key: 'webhook:orders/create:wh-orders-create-1' },
      }),
    );
    expect(idemp).toHaveLength(1);
  });

  it('duplicate delivery (same X-Shopify-Webhook-Id) → 200, writes once only', async () => {
    const merchantId = await createTestMerchant(SHOP);
    const req1 = buildWebhookRequest({
      topic: 'orders/create',
      shop: SHOP,
      webhookId: 'wh-dup',
      body: { id: 999, financial_status: 'paid' },
      secret: SECRET,
    });
    const req2 = buildWebhookRequest({
      topic: 'orders/create',
      shop: SHOP,
      webhookId: 'wh-dup',
      body: { id: 999, financial_status: 'paid' },
      secret: SECRET,
    });

    const res1 = await invokeWebhook(req1);
    const res2 = await invokeWebhook(req2);

    expect(res1.status).toBe(200);
    expect(res1.headers.get('X-Winback-Webhook-Outcome')).toBe('processed');
    expect(res2.status).toBe(200);
    expect(res2.headers.get('X-Winback-Webhook-Outcome')).toBe('duplicate');

    const client = getTestClient();
    const logs = await assertRead(() =>
      client.webhookLog.findMany({ where: { shopifyWebhookId: 'wh-dup' } }),
    );
    expect(logs).toHaveLength(1);

    const events = await assertRead(() =>
      client.outboxEvent.findMany({ where: { merchantId, type: 'order.placed' } }),
    );
    expect(events).toHaveLength(1);
  });

  it('invalid HMAC → 401, zero DB writes', async () => {
    await createTestMerchant(SHOP);

    const res = await invokeWebhook(
      buildWebhookRequest({
        topic: 'orders/create',
        shop: SHOP,
        webhookId: 'wh-bad-hmac',
        body: { id: 1, financial_status: 'paid' },
        secret: SECRET,
        hmacOverride: 'definitely-not-a-valid-hmac',
      }),
    );

    expect(res.status).toBe(401);

    const client = getTestClient();
    const logs = await assertRead(() => client.webhookLog.count());
    const events = await assertRead(() => client.outboxEvent.count());
    const idemp = await assertRead(() => client.idempotencyKey.count());
    expect(logs).toBe(0);
    expect(events).toBe(0);
    expect(idemp).toBe(0);
  });

  it('missing topic header → 400, zero DB writes', async () => {
    await createTestMerchant(SHOP);

    const res = await invokeWebhook(
      buildWebhookRequest({
        topic: 'orders/create',
        shop: SHOP,
        webhookId: 'wh-no-topic',
        body: { id: 1 },
        secret: SECRET,
        omit: new Set(['topic']),
      }),
    );

    expect(res.status).toBe(400);

    const client = getTestClient();
    const logs = await assertRead(() => client.webhookLog.count());
    expect(logs).toBe(0);
  });

  it('invalid shop domain → 400, zero DB writes', async () => {
    const res = await invokeWebhook(
      buildWebhookRequest({
        topic: 'orders/create',
        shop: 'not a real shop domain',
        webhookId: 'wh-bad-shop',
        body: { id: 1 },
        secret: SECRET,
      }),
    );

    expect(res.status).toBe(400);

    const client = getTestClient();
    const logs = await assertRead(() => client.webhookLog.count());
    expect(logs).toBe(0);
  });

  it('merchant doesnt exist → 200, WebhookLog (merchantId=null), no OutboxEvent', async () => {
    // No createTestMerchant — the shop has never installed.
    const res = await invokeWebhook(
      buildWebhookRequest({
        topic: 'orders/create',
        shop: 'unknown-shop.myshopify.com',
        webhookId: 'wh-no-merchant',
        body: { id: 1, financial_status: 'paid' },
        secret: SECRET,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Winback-Webhook-Outcome')).toBe('no_merchant');

    const client = getTestClient();
    const logs = await assertRead(() =>
      client.webhookLog.findMany({ where: { shopifyWebhookId: 'wh-no-merchant' } }),
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      merchantId: null,
      shop: 'unknown-shop.myshopify.com',
      hmacOk: true,
      status: 'failed',
      errorCode: 'merchant_not_found',
    });

    const events = await assertRead(() => client.outboxEvent.count());
    expect(events).toBe(0);
  });

  it('unknown topic (no outbox mapping) → 200, WebhookLog with errorCode, no OutboxEvent', async () => {
    const merchantId = await createTestMerchant(SHOP);

    const res = await invokeWebhook(
      buildWebhookRequest({
        topic: 'shop/update', // not in WEBHOOK_TOPIC_TO_EVENT nor GDPR_TOPIC_TO_EVENT
        shop: SHOP,
        webhookId: 'wh-unknown-topic',
        body: { id: 1 },
        secret: SECRET,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Winback-Webhook-Outcome')).toBe('unknown_topic');

    const client = getTestClient();
    const logs = await assertRead(() =>
      client.webhookLog.findMany({ where: { shopifyWebhookId: 'wh-unknown-topic' } }),
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      topic: 'shop/update',
      status: 'processed',
      errorCode: 'unknown_topic_no_outbox',
    });

    const events = await assertRead(() =>
      client.outboxEvent.findMany({ where: { merchantId } }),
    );
    expect(events).toHaveLength(0);
  });

  it('GDPR shop/redact topic → 200, WebhookLog + OutboxEvent (gdpr.shop_redacted)', async () => {
    const merchantId = await createTestMerchant(SHOP);

    const res = await invokeWebhook(
      buildWebhookRequest({
        topic: 'shop/redact',
        shop: SHOP,
        webhookId: 'wh-gdpr-shop-redact',
        body: { shop_id: 1, shop_domain: SHOP },
        secret: SECRET,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Winback-Webhook-Outcome')).toBe('processed');

    const client = getTestClient();
    const events = await assertRead(() =>
      client.outboxEvent.findMany({ where: { merchantId, type: 'gdpr.shop_redacted' } }),
    );
    expect(events).toHaveLength(1);
  });
});
