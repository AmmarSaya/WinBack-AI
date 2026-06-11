/**
 * Canonical registry of BullMQ queue names. Every producer (Queue
 * construction in @winback/queue) and consumer (Worker construction in D2+)
 * MUST reference a constant from this object — never a string literal.
 * The closed set is the safety property; this registry is its enforcement.
 *
 * Naming convention (same as OUTBOX_EVENTS / AUDIT_ACTIONS / SYSTEM_SCOPE_REASONS
 * — `<domain>.<action>` lowercase, underscores allowed, optional `@v<n>`
 * suffix for payload-shape changes):
 *
 *   outbox.drain
 *   cron.rollup
 *   cron.sweep
 *
 * Same canonical format regex as the three existing dotted registries:
 *   /^[a-z][a-z_]*\.[a-z][a-z_0-9]*(@v[0-9]+)?$/
 *
 * One format, one rule, no exceptions. Adding a fourth registry with a
 * different format would force readers to hold two rules in their head and
 * remember which registry uses which — exactly the drift that produces
 * subtle bugs.
 *
 * Adding a new queue:
 *   1. Add the constant here under the appropriate domain (or create a
 *      new domain if it's the first queue of a category).
 *   2. Use the constant at the call site — `getQueues()` and Worker
 *      construction accept only `QueueName`, not raw strings.
 *   3. The registry's exhaustive shape test in
 *      `packages/contracts/tests/registries.test.ts` will pass automatically.
 *
 * D3 will add `cron.rollup` (CP-2 daily attribution rollup cron) and
 * `cron.sweep` (idempotency / enrichment retry). They are intentionally
 * NOT registered here — speculative entries would dead-export and could
 * mask a real wiring gap (a queue name exists but no caller uses it). When
 * you arrive here as the D3 author: add the new constants under a new
 * `cron` domain, use them at the call site, and the shape test picks them
 * up (standing rule 36).
 *
 * Priority and concurrency budgets are NOT encoded in this registry — they
 * are properties of the Worker that consumes the queue, set at worker
 * construction time.
 *
 * Previously included `attribution.compute`. Removed in the C1 fix —
 * CP-2 §Q1 specifies that attribution work happens INLINE in the drainer's
 * `order.placed` / `order.updated` handler (Order upsert + qualifying-
 * transition check + AttributionEvent insert, all in one tx), not via a
 * separate queue + consumer. The registration was a D2-stub-era artifact
 * with no consumer.
 */

export const QUEUE_NAMES = {
  /**
   * Outbox drainer (D2) consumes unprocessed `OutboxEvent` rows in
   * `createdAt` order and publishes them onto BullMQ. High-priority worker
   * pool — this is the critical path for every business event in the
   * system.
   */
  outbox: {
    /**
     * Outbox drainer claim-and-publish loop. The drainer worker calls
     * `OutboxRepository.claimBatch` (FOR UPDATE SKIP LOCKED), enqueues
     * jobs derived from the claimed rows, then marks them processed in
     * the same transaction. High-priority worker pool.
     */
    drain: 'outbox.drain',
  },
  /**
   * Scheduler / cron queues (D3). Both queues carry BullMQ-repeatable
   * tick jobs registered by the scheduler process at startup; the
   * scheduler's Workers consume each tick.
   */
  cron: {
    /**
     * Hourly UTC rollup tick. Repeatable via `repeat: { pattern: '0 * *
     * * *' }`. The handler selects merchants whose local midnight
     * fell in the preceding hour (CP-2 §Q5) and upserts the daily
     * `MetricsDailyRollup` rows per merchant. D3 ships a STUB handler
     * (selection query + log only — `MetricsDailyRollup` table doesn't
     * exist until H1); H1 fills the upsert math.
     */
    rollup: 'cron.rollup',
    /**
     * Periodic sweep tick. Repeatable via `repeat: { every: 900_000 }`
     * (15 min). Job name discriminates the sweep type — D3 ships
     * `'enrichment-sweep'` only (re-invoke `enrichInstall` for
     * merchants where shopDetailsFetchedAt IS NULL past the 10-min
     * grace). Future sweep types (idempotency cleanup, backfill
     * recovery) land on this queue without a new registry entry.
     */
    sweep: 'cron.sweep',
  },
  /**
   * AI generation pipeline (Epic F). The `customer.state_changed` drainer
   * handler pre-creates an `AiGeneration` row + draft `Message` row in one
   * tx, then enqueues an `ai.generate` job carrying `{ aiGenerationId,
   * merchantId, customerId }`. The AI Worker (separate BullMQ Worker
   * instance inside `apps/drainer`) consumes the queue, calls the active
   * provider via `packages/ai`, and mutates both rows to completed/failed
   * + increments today's `AiSpendBucket` via SELECT FOR UPDATE. Per-
   * merchant concurrency = 1 to respect Shopify Admin API leaky-bucket
   * limits during prompt-context reads. See EPIC-F-DESIGN.md §F-8.
   */
  ai: {
    /**
     * One job per LLM call. BullMQ job ID = `aiGenerationId` (the pre-
     * created DB row's PK) for idempotent replay — if the Worker picks
     * up a job whose AiGeneration.status is no longer `pending`, it
     * no-ops. Retryable on provider 429 / 503 with exponential backoff
     * (max 3 attempts); non-retryable on content-filter / auth /
     * invalid-request / spend-ceiling rejections.
     */
    generate: 'ai.generate',
  },
  /**
   * Campaign dispatch pipeline (Epic G batch 8.2). The scheduler's
   * `dispatch-sweep` tick (a job-name on `cron.sweep`, NOT a queue of its
   * own — see `cron.sweep`'s note) selects dispatch-eligible draft
   * Messages per active Campaign and enqueues ONE `campaign.dispatch` job
   * per draft, carrying `{ merchantId, messageId, campaignId, customerId }`.
   * The dispatch Worker (a separate BullMQ Worker instance inside
   * `apps/drainer`, sibling to the AI Worker) consumes the queue and
   * CLAIMS each draft by creating its `CampaignTarget` (status=pending) —
   * idempotent on `CampaignTarget.messageId @unique` (a P2002 on replay is
   * a no-op). v1 skeleton stops at the claim: NO gate chain (8.3), NO send
   * (8.4). See EPIC-G-DESIGN.md §dispatch.
   */
  campaign: {
    /**
     * One job per dispatch-eligible draft Message. NO BullMQ jobId is set
     * — idempotency is carried by the producer's `NOT EXISTS CampaignTarget`
     * pre-filter + the `messageId @unique` constraint at claim time (a
     * jobId would risk a failed-job-wedge with `removeOnComplete`). The
     * 15-min `dispatch-sweep` re-enqueues any still-unclaimed draft.
     */
    dispatch: 'campaign.dispatch',
  },
} as const;

/**
 * Flat union of every queue name literal — the type used at BullMQ Queue
 * and Worker construction sites in `@winback/queue` (D1+).
 */
export type QueueName =
  | (typeof QUEUE_NAMES.outbox)[keyof typeof QUEUE_NAMES.outbox]
  | (typeof QUEUE_NAMES.cron)[keyof typeof QUEUE_NAMES.cron]
  | (typeof QUEUE_NAMES.ai)[keyof typeof QUEUE_NAMES.ai]
  | (typeof QUEUE_NAMES.campaign)[keyof typeof QUEUE_NAMES.campaign];

/** Runtime Set of every registered queue name, for shape tests + iteration. */
export const ALL_QUEUE_NAMES: ReadonlySet<QueueName> = new Set([
  ...Object.values(QUEUE_NAMES.outbox),
  ...Object.values(QUEUE_NAMES.cron),
  ...Object.values(QUEUE_NAMES.ai),
  ...Object.values(QUEUE_NAMES.campaign),
] as QueueName[]);

/**
 * Predicate. Useful for inputs typed `string` at a boundary (e.g. CLI
 * args, untrusted job-name parsing from external configuration) before
 * they cross into `QueueName`-typed code.
 */
export function isQueueName(value: string): value is QueueName {
  return ALL_QUEUE_NAMES.has(value as QueueName);
}

/**
 * BullMQ job NAME (label) for every `campaign.dispatch` job (Epic G batch
 * 8.2). The dispatch Worker consumes a DEDICATED queue and processes all jobs
 * identically — it does NOT switch on this name (unlike the `cron.sweep`
 * worker, whose queue carries multiple sweep types discriminated by name). The
 * name is a producer-side observability label only.
 */
export const CAMPAIGN_DISPATCH_JOB_NAME = 'dispatch';

/**
 * Payload for a `campaign.dispatch` job (Epic G batch 8.2). Producer = the
 * scheduler `dispatch-sweep` tick (one job per dispatch-eligible draft);
 * consumer = the dispatch Worker in `apps/drainer`. Shared here because the
 * producer and consumer live in DIFFERENT apps — `campaign.dispatch` is the
 * first cross-app queue (every prior queue's producer + consumer were
 * co-located, so their payload type lived in the worker file).
 *
 * No BullMQ jobId is derived from this payload: idempotency is the producer's
 * `NOT EXISTS CampaignTarget` pre-filter + the `messageId @unique` claim, so a
 * jobId would only add a failed-job-wedge risk under `removeOnComplete`.
 */
export interface CampaignDispatchJobPayload {
  readonly merchantId: string;
  readonly messageId: string;
  readonly campaignId: string;
  readonly customerId: string;
}
