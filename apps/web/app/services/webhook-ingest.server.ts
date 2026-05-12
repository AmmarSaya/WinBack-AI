import { Prisma } from '@prisma/client';
import { type WinbackPrisma, withSystemScope } from '@winback/db';
import { getLogger } from '@winback/logger';
import {
  getOutboxEventForTopic,
  getShopifyConfig,
  isValidShopDomain,
  verifyShopifyWebhookHmac,
} from '@winback/shopify';

const log = getLogger('web.webhook.ingest');

const IDEMPOTENCY_TTL_MS = 7 * 86_400_000; // 7 days — wider than Shopify's retry window

export interface IngestArgs {
  readonly topic: string | null;
  readonly shop: string | null;
  readonly webhookId: string | null;
  readonly hmac: string | null;
  readonly rawBody: string;
}

export type IngestOutcome =
  | { kind: 'accept'; reason: 'processed' | 'duplicate' | 'no_merchant' | 'unknown_topic' }
  | { kind: 'reject'; status: 400 | 401; reason: 'missing_headers' | 'invalid_shop' | 'hmac' };

/**
 * Webhook ingestion. Strict boundary — does ONLY:
 *
 *   1. Validate headers.
 *   2. Verify HMAC.
 *   3. Resolve merchant.
 *   4. Single tx: claim IdempotencyKey + write WebhookLog + write OutboxEvent.
 *   5. Return outcome (caller maps to HTTP response).
 *
 * The atomic tx in step 4 IS the "enqueue" — the OutboxEvent row is the
 * durable handoff to the drainer (D2). If anything in step 4 fails, the
 * caller surfaces 5xx and Shopify retries (no IdempotencyKey row written,
 * so retry is clean).
 *
 * Dedup is via unique-violation on `IdempotencyKey(merchantId, key)` where
 * key = `webhook:<topic>:<X-Shopify-Webhook-Id>`. Shopify guarantees the
 * webhook-id header is unique per delivery. We NEVER hash the payload.
 *
 * No business logic anywhere. The drainer does the work.
 */
export async function ingestWebhook(
  prisma: WinbackPrisma,
  args: IngestArgs,
): Promise<IngestOutcome> {
  // 1. Header presence.
  if (
    args.topic === null ||
    args.shop === null ||
    args.webhookId === null ||
    args.hmac === null
  ) {
    return { kind: 'reject', status: 400, reason: 'missing_headers' };
  }
  if (!isValidShopDomain(args.shop)) {
    return { kind: 'reject', status: 400, reason: 'invalid_shop' };
  }

  // 2. HMAC. Sync; no DB.
  const config = getShopifyConfig();
  const webhookSecret = config.SHOPIFY_WEBHOOK_SECRET ?? config.SHOPIFY_API_SECRET;
  if (!verifyShopifyWebhookHmac(webhookSecret, args.rawBody, args.hmac)) {
    log.warn({ shop: args.shop, topic: args.topic }, 'webhook: HMAC failed');
    return { kind: 'reject', status: 401, reason: 'hmac' };
  }

  // Past this point: request is authenticated. Ack semantics now apply —
  // we must produce a 200 for any condition Shopify shouldn't retry.
  const { topic, shop, webhookId, rawBody } = args;
  const eventType = getOutboxEventForTopic(topic);
  const parsedBody = tryParseJson(rawBody);

  return withSystemScope('webhook.ingest', async () => {
    // 3. Merchant resolution.
    const merchant = await prisma.merchant.findUnique({
      where: { shop },
      select: { id: true },
    });

    // 3a. No merchant (uninstalled or never installed). Log + ack.
    // Shouldn't make Shopify retry forever.
    if (merchant === null) {
      await prisma.webhookLog.create({
        data: {
          merchantId: null,
          shop,
          topic,
          shopifyWebhookId: webhookId,
          hmacOk: true,
          status: 'failed',
          errorCode: 'merchant_not_found',
          payload: parsedBody,
          payloadSize: rawBody.length,
          processedAt: new Date(),
        },
      });
      return { kind: 'accept', reason: 'no_merchant' };
    }

    const merchantId = merchant.id;
    const idempKey = `webhook:${topic}:${webhookId}`;
    const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS);
    const statusForLog = eventType === null ? 'processed' : 'processed';
    const errorCodeForLog = eventType === null ? 'unknown_topic_no_outbox' : null;

    // 4. Atomic ingestion.
    try {
      await prisma.$transaction(
        async (tx) => {
          // (a) Claim idempotency. Unique violation → duplicate delivery.
          await tx.idempotencyKey.create({
            data: { merchantId, key: idempKey, expiresAt },
          });

          // (b) Webhook log row (audit trail).
          await tx.webhookLog.create({
            data: {
              merchantId,
              shop,
              topic,
              shopifyWebhookId: webhookId,
              idempotencyKey: idempKey,
              hmacOk: true,
              status: statusForLog,
              errorCode: errorCodeForLog,
              payload: parsedBody,
              payloadSize: rawBody.length,
              processedAt: new Date(),
            },
          });

          // (c) Outbox publish, if topic maps to an event.
          // GDPR topics + unknown topics: WebhookLog only; no outbox event.
          if (eventType !== null) {
            await tx.outboxEvent.create({
              data: {
                merchantId,
                type: eventType,
                payload: {
                  topic,
                  webhookId,
                  body: parsedBody,
                } as Prisma.InputJsonValue,
              },
            });
          }
        },
        // Webhook handler runs under Shopify's 5-second budget. The tx
        // itself is three small inserts; 2s is generous.
        { maxWait: 1_000, timeout: 2_000 },
      );
      log.info(
        {
          shop,
          topic,
          webhookId,
          merchantId,
          hasOutbox: eventType !== null,
        },
        'webhook ingested',
      );
      return {
        kind: 'accept',
        reason: eventType === null ? 'unknown_topic' : 'processed',
      };
    } catch (err) {
      // Unique violation on IdempotencyKey = Shopify retried a delivery
      // we've already accepted. Ack 200 without re-processing.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        log.info({ shop, topic, webhookId, merchantId }, 'webhook: duplicate delivery');
        return { kind: 'accept', reason: 'duplicate' };
      }
      log.error({ err, shop, topic, webhookId, merchantId }, 'webhook: ingestion failed');
      throw err; // Caller surfaces 5xx → Shopify will retry
    }
  });
}

function tryParseJson(raw: string): Prisma.InputJsonValue {
  if (raw.length === 0) return {} as Prisma.InputJsonValue;
  try {
    return JSON.parse(raw) as Prisma.InputJsonValue;
  } catch {
    // Malformed body. Log a truncated raw fragment so debuggers can see it
    // without unbounded storage.
    return { _malformed: true, _raw_prefix: raw.slice(0, 500) } as Prisma.InputJsonValue;
  }
}
