/**
 * Integration tests for @winback/queue — exercises the full stack
 * (ioredis client + BullMQ Queue + real Redis) without mocks.
 *
 * Run via `pnpm queue:test` which boots Docker Redis on port 6380,
 * waits for PONG, then dispatches vitest with REDIS_URL injected.
 *
 * Four tests, each pinning a load-bearing property of the package:
 *   1. createRedisClient connects — client.ping() returns 'PONG'.
 *      Proves the factory's ioredis options are compatible with a real
 *      server (TLS off for redis://, BullMQ-required options applied).
 *   2. getQueues produces working Queues — outboxDrain.add() resolves.
 *      Proves the BullMQ + ioredis + shared-connection wiring works
 *      end-to-end against real Redis.
 *   3. Jobs round-trip through Redis with payload integrity preserved.
 *      Per Checkpoint 2: nested object payload covers UUID string,
 *      nested object, ISO date string, integer array, scalar integer —
 *      all in one job to catch any JSON-serialization mangling.
 *   4. closeQueues actually disconnects — client.status === 'end' after
 *      close (Checkpoint 4: BullMQ@5.76.8 does not reliably throw on
 *      .add() after close, so asserting that would be a green test for
 *      the wrong behavior).
 */

import { randomUUID } from 'node:crypto';

import { QUEUE_NAMES } from '@winback/contracts';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRedisClient } from '../../src/redis-client.js';
import {
  __getSharedClientForTesting,
  closeQueues,
  getQueues,
} from '../../src/queues.js';

import { resetRedis, teardown } from './setup.js';

beforeEach(async () => {
  // Silence the documented double-close warning from closeQueues — the
  // defensive close below hits the "no queues open" branch on the first
  // test (and any test that doesn't open queues), and the warning is
  // expected, not a regression. LOG_LEVEL=fatal in queue-test.mjs only
  // affects pino loggers; console.warn bypasses it.
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  // Each test starts with empty Redis. FLUSHDB is fast (sub-millisecond
  // on a small dataset). Also defensively close any queues that a prior
  // test forgot to close — closeQueues is idempotent over double-call.
  await closeQueues();
  await resetRedis();
});

afterEach(() => {
  // Restore all mocks. Safe in integration tests because we only use
  // vi.spyOn (e.g., for console.warn) and do not use vi.mock to replace
  // module implementations. This is intentionally different from
  // queues.test.ts where vi.restoreAllMocks() would break the vi.fn
  // instances attached to mocked Queue internals.
  vi.restoreAllMocks();
});

afterAll(async () => {
  // Per Checkpoint 3 — teardown is wrapped in try/catch inside setup.ts.
  // On failure it throws; vitest marks the suite failed and exits with
  // code 1 naturally. On success it logs a specific message confirming
  // clean teardown.
  await teardown();
});

describe('@winback/queue — integration', () => {
  it('1. createRedisClient connects to real Redis and PINGs successfully', async () => {
    const client = createRedisClient('test.ping');

    const reply = await client.ping();
    expect(reply).toBe('PONG');

    // Clean up this test's standalone client — not used elsewhere.
    await client.quit();
  });

  it('2. getQueues produces working Queue instances against real Redis', async () => {
    const queues = getQueues();

    // Add a job to each queue with a minimal payload — proves the BullMQ +
    // ioredis + shared-connection wiring is operational. Returns the
    // Job object once Redis acknowledges the LPUSH/XADD; an error would
    // propagate as a rejected promise.
    const outboxJob = await queues.outboxDrain.add('test-2', { ping: 'outbox' });
    const attribJob = await queues.attributionCompute.add('test-2', {
      ping: 'attribution',
    });

    expect(outboxJob.id).toBeDefined();
    expect(attribJob.id).toBeDefined();
  });

  it('3. jobs round-trip through Redis with nested-payload integrity preserved (Checkpoint 2)', async () => {
    const queues = getQueues();

    // Per Checkpoint 2: nested payload covering UUID (string), nested
    // object, ISO date string, integer array, scalar integer — one job,
    // five types of data, single round-trip assertion catches mangling
    // anywhere in the JSON serialization path.
    const payload = {
      testId: randomUUID(),
      nested: {
        value: 42,
        timestamp: new Date().toISOString(),
      },
      arr: [1, 2, 3],
    };

    const added = await queues.outboxDrain.add('test-3', payload);
    expect(added.id).toBeDefined();

    // Read back via Queue.getJobs(['waiting']) — fetches the newly added
    // job from the waiting state (no worker has claimed it).
    const jobs = await queues.outboxDrain.getJobs(['waiting']);
    expect(jobs).toHaveLength(1);

    const retrieved = jobs[0];
    expect(retrieved).toBeDefined();
    // Deep equality on .data — toEqual is value-equality, so it
    // tolerates the new-object-instances that come back from
    // deserialization. Any mangling of any field (UUID truncation,
    // timestamp string normalization, array reordering, integer
    // coercion) would surface here.
    expect(retrieved!.data).toEqual(payload);

    // Also assert the queue's queryable depth matches — proves the job
    // is observable via the public BullMQ API, not just an artifact
    // of getJobs() implementation.
    const waitingCount = await queues.outboxDrain.getWaitingCount();
    expect(waitingCount).toBe(1);
  });

  it('4. closeQueues actually disconnects — shared client status is "end" after close (Checkpoint 4)', async () => {
    const queues = getQueues();

    // Capture the shared client reference BEFORE closeQueues clears the
    // module's pointer to it. After close, __getSharedClientForTesting
    // returns null — but the underlying Redis instance still exists,
    // just with status === 'end'.
    const captured = __getSharedClientForTesting();
    expect(captured).not.toBeNull();

    // Wait for BOTH Queues' BullMQ setup to complete before exercising
    // the close path. BullMQ Queue construction is synchronous on the
    // JS side, but it issues background setup commands (script LOAD,
    // CLIENT SETNAME) on the connection. If we disconnect while those
    // commands are still in flight, they reject with `AbortError:
    // Command aborted due to connection close`. BullMQ does not catch
    // those internally — they bubble out as unhandled rejections which
    // vitest reports as test errors (even when assertions pass).
    // waitUntilReady awaits the setup-complete signal.
    await Promise.all([
      queues.outboxDrain.waitUntilReady(),
      queues.attributionCompute.waitUntilReady(),
    ]);
    expect(captured!.status).toBe('ready');

    await closeQueues();

    // The load-bearing assertion. If closeQueues somehow regressed to
    // not actually calling .quit() on the shared client (e.g. the
    // try/finally branch logic was reshuffled and the quit() call got
    // skipped), this would fail with the captured client still in
    // 'ready' state. Asserting .add() throws would NOT catch that
    // class of regression in BullMQ@5.76.8.
    expect(captured!.status).toBe('end');

    // Also verify the package's view: the module's reference is null
    // after a successful close.
    expect(__getSharedClientForTesting()).toBeNull();
  });
});
