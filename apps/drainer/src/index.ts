/**
 * Drainer process entry.
 *
 * Lifecycle:
 *
 *   1. Read config (Shopify, ENCRYPTION_KEY, Redis).
 *   2. Construct DrainerContext (prisma, queues, shopifyConfig).
 *   3. Build THREE BullMQ Workers:
 *        - `outbox.drain` Worker (createDrainerWorker — D2)
 *        - `ai.generate` Worker (createAiGenerateWorker — Epic F batch 4)
 *        - `campaign.dispatch` Worker (createDispatchWorker — Epic G batch 8.2)
 *      Each owns its own ioredis connection per the BullMQ blocking-
 *      commands rule (see packages/queue/src/redis-client.ts header).
 *   4. Enqueue one initial tick job (the outbox Worker self-re-enqueues
 *      thereafter; the AI Worker is purely producer-driven by Step 2b's
 *      handler).
 *   5. Install SIGTERM / SIGINT handlers for graceful shutdown.
 *   6. Process runs indefinitely.
 *
 * Graceful shutdown (Q-B1: parallel worker close via Promise.allSettled
 * for per-worker error isolation + matching the handoff doc's explicit
 * "close in parallel" wording):
 *   - drainerWorker.close() + aiWorker.close() + dispatchWorker.close()
 *     — PARALLEL via `Promise.allSettled`. Each finishes its in-flight
 *     job + refuses new jobs. Per-worker errors logged but never block
 *     the rest of the shutdown.
 *   - closeQueues() — closes the shared Queue ioredis client AFTER both
 *     workers (workers may write back to the Queue handle during
 *     in-flight finish).
 *   - disconnectPrisma() — releases the DB pool LAST (workers may
 *     write to Prisma during in-flight finish; queues + Prisma are
 *     independent so order within Prisma doesn't matter, but workers
 *     → queues → prisma is the safe order).
 *
 * Each shutdown step is idempotent over double-call. Top-level
 * `shuttingDown` flag prevents re-entry when SIGTERM + SIGINT arrive
 * back-to-back.
 *
 * Test seam (Step 2d Phase 2): `main` is exported and the auto-
 * invocation at file bottom is gated on `NODE_ENV !== 'test'`. Tests
 * `import { main } from './index.js'` and call it explicitly with all
 * boundary modules mocked. Production (`NODE_ENV=production`) and dev
 * (`NODE_ENV=development` or unset) both auto-invoke as before.
 */

import { getEmailConfig, selectActiveEmailProvider } from '@winback/email';
import { getLogger } from '@winback/logger';
import { closeQueues, getQueues } from '@winback/queue';
import { getShopifyConfig } from '@winback/shopify';

import type { DrainerContext } from './context.js';
import { disconnectPrisma, getPrisma } from './db.js';
import { enqueueInitialTick } from './scheduling.js';
import { createDrainerWorker } from './worker.js';
import { createAiGenerateWorker } from './workers/ai-generate.worker.js';
import { createDispatchWorker } from './workers/dispatch.worker.js';

const log = getLogger('drainer.main');

export async function main(): Promise<void> {
  log.info('drainer: starting');

  const shopifyConfig = getShopifyConfig();
  const prisma = getPrisma();
  const queues = getQueues();

  // Epic G batch 8.4 — boot the ESP. Validates env synchronously; throws
  // ConfigError on misconfiguration so a missing AWS_SES_* surfaces at
  // process start, not at the first dispatch.
  //
  // `EmailConfig` is a z.discriminatedUnion shape with a single member
  // (`amazon-ses`) at 8.4. The fields below are accessed directly — when a
  // second provider joins the union, narrow via `EMAIL_PROVIDER` switch.
  const emailConfig = getEmailConfig();
  const emailProvider = selectActiveEmailProvider(emailConfig);
  if (!emailConfig.AWS_SES_SANDBOX) {
    // Sandbox is the locked 8.4 build assumption. A boot that points at a
    // production-out-of-sandbox SES account is a DELIBERATE operator action
    // (the launch switch) — surface it loudly so it doesn't slip past in
    // routine deploys.
    log.warn(
      { provider: emailConfig.EMAIL_PROVIDER },
      'drainer: AWS_SES_SANDBOX is not true — running against PRODUCTION SES (launch-day posture)',
    );
  }

  const ctx: DrainerContext = {
    prisma,
    queues,
    shopifyConfig,
    emailProvider,
    emailFromAddress: emailConfig.AWS_SES_FROM_ADDRESS,
    emailConfigurationSetName: emailConfig.AWS_SES_CONFIGURATION_SET,
  };

  // Q-B3: explicit per-worker names. Three Workers in one process, an
  // unnamed `worker` is a refactor hazard.
  const drainerWorker = createDrainerWorker(ctx);
  const aiWorker = createAiGenerateWorker(ctx);
  // Epic G batch 8.2 — consumes `campaign.dispatch` (producer = scheduler
  // dispatch-sweep tick). Claims a CampaignTarget per draft; gates + send land
  // in later batches.
  const dispatchWorker = createDispatchWorker(ctx);

  await enqueueInitialTick(queues.outboxDrain);
  log.info(
    'drainer: initial tick enqueued; outbox drain + ai-generate + campaign-dispatch workers running',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      log.warn(
        { signal },
        'drainer: shutdown already in progress; ignoring signal',
      );
      return;
    }
    shuttingDown = true;
    log.info({ signal }, 'drainer: shutdown initiated');

    // Q-B1 — PARALLEL worker close via Promise.allSettled. Both
    // Workers own independent ioredis connections (no shared resource
    // contention) so concurrent close is safe. Per-worker error
    // isolation: if one close throws, the other still completes + we
    // get separate log lines for each failure.
    const [drainerResult, aiResult, dispatchResult] = await Promise.allSettled([
      drainerWorker.close(),
      aiWorker.close(),
      dispatchWorker.close(),
    ]);
    if (drainerResult.status === 'rejected') {
      log.error(
        { err: drainerResult.reason },
        'drainer: outbox drain worker close threw',
      );
    } else {
      log.info('drainer: outbox drain worker closed');
    }
    if (aiResult.status === 'rejected') {
      log.error(
        { err: aiResult.reason },
        'drainer: ai-generate worker close threw',
      );
    } else {
      log.info('drainer: ai-generate worker closed');
    }
    if (dispatchResult.status === 'rejected') {
      log.error(
        { err: dispatchResult.reason },
        'drainer: campaign-dispatch worker close threw',
      );
    } else {
      log.info('drainer: campaign-dispatch worker closed');
    }

    try {
      await closeQueues();
      log.info('drainer: queues closed');
    } catch (err) {
      log.error({ err }, 'drainer: closeQueues threw');
    }

    try {
      await disconnectPrisma();
      log.info('drainer: prisma disconnected');
    } catch (err) {
      log.error({ err }, 'drainer: prisma disconnect threw');
    }

    log.info('drainer: shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

// Auto-invocation gate (test seam). vitest sets NODE_ENV=test
// (apps/drainer/vitest.config.ts:14), so tests `import { main }` from
// this file without triggering boot. Production + dev are unaffected
// (NODE_ENV=production from Render env / NODE_ENV=development or unset
// from tsx). Tests call `await main()` explicitly with mocks set up.
if (process.env.NODE_ENV !== 'test') {
  main().catch((err: unknown) => {
    // Top-level failure (config validation, Redis unreachable at boot, etc.).
    // Log + exit non-zero so the orchestrator restarts the process.
    log.error({ err }, 'drainer: fatal startup error');
    process.exit(1);
  });
}
