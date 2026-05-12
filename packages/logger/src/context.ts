import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-async-chain log context. Every field is optional — boundaries bind only
 * what they know.
 *
 * Field conventions (locked here so the rest of the codebase is consistent):
 *   requestId      — unique per inbound HTTP request / webhook delivery
 *   correlationId  — propagates across queue boundaries; survives job hops
 *   merchantId     — tenant scope (set post-auth)
 *   jobId          — BullMQ job id
 *   queue          — queue name this work item came from
 *   shopifyTopic   — webhook topic (e.g. "orders/create")
 */
export interface LogContext {
  readonly requestId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly merchantId?: string | undefined;
  readonly jobId?: string | undefined;
  readonly queue?: string | undefined;
  readonly shopifyTopic?: string | undefined;
}

const als = new AsyncLocalStorage<LogContext>();

/**
 * Runs `fn` inside the given log context. All `getLogger().info(...)` calls
 * within `fn` (and any awaited descendants) automatically include the context
 * fields in their log records.
 *
 * Nested calls MERGE with the outer scope rather than replacing it — an inner
 * webhook handler can add `shopifyTopic` without losing the outer request's
 * `requestId`.
 *
 * Use this at every system boundary:
 *   - HTTP handler entry → bind requestId (+ merchantId post-auth)
 *   - Webhook ingestion  → bind requestId, merchantId, shopifyTopic
 *   - Worker job entry   → bind jobId, queue, correlationId, merchantId
 *                          (read from job payload — ALS does NOT survive
 *                          serialization across the queue)
 */
export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  const parent = als.getStore();
  const merged: LogContext = parent !== undefined ? { ...parent, ...ctx } : ctx;
  return als.run(merged, fn);
}

/**
 * Reads the current log context. Returns `undefined` outside any
 * `runWithLogContext` scope.
 *
 * Most code should NOT call this — the logger pulls context automatically via
 * its mixin. Reserve this for the rare cases that need to enrich a non-log
 * payload (e.g. propagating `correlationId` into an enqueued job's data).
 */
export function getLogContext(): LogContext | undefined {
  return als.getStore();
}
