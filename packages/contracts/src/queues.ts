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
 *   attribution.compute
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
 * construction time. Per CP-2 carry-forward: the `attribution.compute`
 * worker MUST run with a lower BullMQ priority and a separate (smaller)
 * concurrency budget than the `outbox.drain` worker, so heavy attribution
 * computation cannot starve order ingestion under load.
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
   * Attribution computation (H1) — triggered by `order.placed` /
   * `order.updated` outbox events that qualify per the CP-2 transition
   * rules. Lands `AttributionEvent` rows. Lower priority than
   * `outbox.drain` so heavy attribution work cannot starve order
   * ingestion under load. Separate concurrency budget per CP-2
   * carry-forward.
   */
  attribution: {
    /**
     * Computes an `AttributionEvent` for a single qualifying order.
     * Idempotent via the `(merchantId, orderId)` unique index on
     * `AttributionEvent`. H1 wires the actual handler; D2 stubs the
     * call site, dispatching jobs onto this queue from the outbox
     * drainer when an `order.*` event satisfies the CP-2 qualifying
     * transition.
     */
    compute: 'attribution.compute',
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
} as const;

/**
 * Flat union of every queue name literal — the type used at BullMQ Queue
 * and Worker construction sites in `@winback/queue` (D1+).
 */
export type QueueName =
  | (typeof QUEUE_NAMES.outbox)[keyof typeof QUEUE_NAMES.outbox]
  | (typeof QUEUE_NAMES.attribution)[keyof typeof QUEUE_NAMES.attribution]
  | (typeof QUEUE_NAMES.cron)[keyof typeof QUEUE_NAMES.cron];

/** Runtime Set of every registered queue name, for shape tests + iteration. */
export const ALL_QUEUE_NAMES: ReadonlySet<QueueName> = new Set([
  ...Object.values(QUEUE_NAMES.outbox),
  ...Object.values(QUEUE_NAMES.attribution),
  ...Object.values(QUEUE_NAMES.cron),
] as QueueName[]);

/**
 * Predicate. Useful for inputs typed `string` at a boundary (e.g. CLI
 * args, untrusted job-name parsing from external configuration) before
 * they cross into `QueueName`-typed code.
 */
export function isQueueName(value: string): value is QueueName {
  return ALL_QUEUE_NAMES.has(value as QueueName);
}
