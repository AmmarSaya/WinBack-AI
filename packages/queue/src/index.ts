// =============================================================================
// @winback/queue — public surface
//
// Two responsibilities:
//   1. `createRedisClient(name)` — factory for ioredis clients with the
//      BullMQ-required options baked in. Workers (D2+) and the future
//      cache layer call this directly to get their own dedicated
//      connections.
//   2. `getQueues()` / `closeQueues()` — typed BullMQ Queue registry for
//      every name in `QUEUE_NAMES`. The Queues share one ioredis client
//      internally; consumers receive Queue handles, not the connection.
//
// Connection sharing rule (encoded in src/redis-client.ts header):
//   SHARE WITHIN A CONSUMER CLASS, NOT ACROSS CLASSES.
//   - Queue instances may share one connection (non-blocking commands).
//   - Each Worker MUST have its own connection (blocking commands).
//   - The future cache layer gets its own connection (different profile).
// =============================================================================

export { createRedisClient } from './redis-client.js';
export { getQueues, closeQueues } from './queues.js';
export type { Queues } from './types.js';
