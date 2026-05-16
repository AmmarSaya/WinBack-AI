/**
 * Unit tests for `getQueues` + `closeQueues` — registry shape and
 * lifecycle without an actual Redis or BullMQ wire-up.
 *
 * Both `bullmq` and the local `./redis-client.js` are vi.mock'd so the
 * test exercises the wiring logic in queues.ts without opening a TCP
 * connection or instantiating real BullMQ Queue internals. Real-Redis
 * tests land in step 5 with Docker Redis.
 *
 * Three tests, one per behavior:
 *   1. Returns object keyed by QUEUE_NAMES values, both Queue instances
 *      constructed against the shared client.
 *   2. Memoized — repeated calls return same reference, single Queue
 *      construction pass, single shared-client construction.
 *   3. closeQueues closes both Queues + quits shared client + clears
 *      memoization so next getQueues() re-initializes fresh.
 */

import { QUEUE_NAMES } from '@winback/contracts';
import { Queue } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { closeQueues, getQueues } from '../src/queues.js';
import { createRedisClient } from '../src/redis-client.js';

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function (this: object, name: string) {
    (this as { name: string }).name = name;
    (this as { close: Mock }).close = vi.fn().mockResolvedValue(undefined);
  }),
}));

// Mock client that mimics enough of the ioredis surface area for closeQueues
// to exercise its post-disconnect 'end'-event wait. We use a tiny EventEmitter
// to register listeners; the disconnect mock synchronously emits 'end' so the
// awaited endPromise inside closeQueues resolves without hanging the test.
// Real-Redis 'end'-event semantics (async via socket close) are exercised in
// the step-5 integration suite.
import { EventEmitter } from 'node:events';

vi.mock('../src/redis-client.js', () => ({
  createRedisClient: vi.fn((connectionName: string) => {
    const emitter = new EventEmitter();
    const client = Object.assign(emitter, {
      connectionName,
      status: 'ready' as 'ready' | 'end',
      disconnect: vi.fn(() => {
        // Match the production-code contract: after disconnect, the client
        // emits 'end' and transitions to status 'end'. Done synchronously
        // here so tests don't need to await microtasks.
        client.status = 'end';
        emitter.emit('end');
      }),
      // `quit` retained for future asymmetric usage; closeQueues calls
      // disconnect ONLY, so this is unused in step 5 but documents that the
      // mock surface intentionally covers both verbs.
      quit: vi.fn().mockResolvedValue('OK'),
    });
    return client;
  }),
}));

const QueueMock = vi.mocked(Queue);
const createRedisClientMock = vi.mocked(createRedisClient);

// Test-level state for the console.warn spy so we can selectively restore
// it without using vi.restoreAllMocks (which also resets the vi.fn
// instances attached to mocked Queue instances' .close methods — see the
// commit history for the diagnostic chain that produced this design).
let warnSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  // Silence the documented double-close warning that fires inside
  // afterEach when no queues were opened in this test. Test #3 explicitly
  // asserts shutdown behavior; it doesn't rely on console output.
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Reset call history (not implementations) so each test's call counts
  // are independent. mockClear keeps the Queue / createRedisClient
  // implementations intact across tests.
  QueueMock.mockClear();
  createRedisClientMock.mockClear();
});

afterEach(async () => {
  // Close any opened queues BEFORE restoring the spy — this exercises
  // the close path against intact mocks. If queues weren't opened in
  // this test, closeQueues hits the warning branch silently (spy is
  // still active).
  await closeQueues();
  // Restore ONLY the console.warn spy. Do NOT use vi.restoreAllMocks() —
  // that would reset the vi.fn implementations attached to the Queue
  // mock's .close methods on instances stored in module-level state,
  // and the next test's afterEach would fail with "close is not a
  // function" when it tries to close stale instances.
  warnSpy?.mockRestore();
  warnSpy = null;
});

describe('getQueues + closeQueues', () => {
  it('1. returns an object with all four Queue instances using QUEUE_NAMES values', () => {
    const queues = getQueues();

    expect(queues.outboxDrain).toBeDefined();
    expect(queues.attributionCompute).toBeDefined();
    expect(queues.cronRollup).toBeDefined();
    expect(queues.cronSweep).toBeDefined();

    // BullMQ's Queue constructor was called four times with the canonical
    // names from the QUEUE_NAMES registry — never string literals.
    expect(QueueMock).toHaveBeenCalledTimes(4);
    expect(QueueMock).toHaveBeenNthCalledWith(
      1,
      QUEUE_NAMES.outbox.drain,
      expect.objectContaining({ connection: expect.any(Object) }),
    );
    expect(QueueMock).toHaveBeenNthCalledWith(
      2,
      QUEUE_NAMES.attribution.compute,
      expect.objectContaining({ connection: expect.any(Object) }),
    );
    expect(QueueMock).toHaveBeenNthCalledWith(
      3,
      QUEUE_NAMES.cron.rollup,
      expect.objectContaining({ connection: expect.any(Object) }),
    );
    expect(QueueMock).toHaveBeenNthCalledWith(
      4,
      QUEUE_NAMES.cron.sweep,
      expect.objectContaining({ connection: expect.any(Object) }),
    );
  });

  it('2. is memoized — repeated calls return the same Queues reference, single Queue + Redis client construction', () => {
    const first = getQueues();
    const second = getQueues();
    const third = getQueues();

    expect(second).toBe(first);
    expect(third).toBe(first);

    // Queue constructor called exactly four times total (once per queue, on
    // the first getQueues() call only). Subsequent calls hit the cache.
    expect(QueueMock).toHaveBeenCalledTimes(4);

    // Single shared ioredis client across all Queues — exactly one
    // createRedisClient invocation with the documented connection name.
    expect(createRedisClientMock).toHaveBeenCalledTimes(1);
    expect(createRedisClientMock).toHaveBeenCalledWith('queues.shared');
  });

  it('3. closeQueues closes all four Queue instances + the shared client, clears the cache, and re-initializes fresh on next getQueues()', async () => {
    const first = getQueues();

    // Capture the mock-Queue close fns BEFORE closing — after close, the
    // mocked module state can drift if other tests interleave.
    const outboxClose = (first.outboxDrain as unknown as { close: Mock }).close;
    const attribClose = (first.attributionCompute as unknown as { close: Mock }).close;
    const rollupClose = (first.cronRollup as unknown as { close: Mock }).close;
    const sweepClose = (first.cronSweep as unknown as { close: Mock }).close;
    // Guard the mock.results[0] access so a "no createRedisClient call was
    // recorded" regression surfaces as a clean assertion failure rather
    // than a confusing TypeError on the .quit property access below.
    expect(createRedisClientMock.mock.results[0]).toBeDefined();
    const firstClientResult = createRedisClientMock.mock.results[0]!.value as {
      disconnect: Mock;
      quit: Mock;
    };

    await closeQueues();

    // Each Queue's close() was invoked once.
    expect(outboxClose).toHaveBeenCalledTimes(1);
    expect(attribClose).toHaveBeenCalledTimes(1);
    expect(rollupClose).toHaveBeenCalledTimes(1);
    expect(sweepClose).toHaveBeenCalledTimes(1);
    // Shared client was disconnected (NOT quit — see queues.ts header
    // for why disconnect is the deterministic choice at shutdown).
    expect(firstClientResult.disconnect).toHaveBeenCalledTimes(1);
    expect(firstClientResult.quit).not.toHaveBeenCalled();

    // Cache cleared — next getQueues() re-initializes (different
    // Queues reference + a fresh createRedisClient call). The user
    // approved this behavior in Q4-c as an explicit re-init-after-close
    // safety valve for test ergonomics.
    const second = getQueues();
    expect(second).not.toBe(first);
    expect(createRedisClientMock).toHaveBeenCalledTimes(2);
  });
});
