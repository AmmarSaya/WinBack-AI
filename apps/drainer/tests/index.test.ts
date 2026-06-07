/**
 * Boot + shutdown sequence tests for the drainer entrypoint
 * (Epic F batch 4 Step 2d — closes a pre-existing tech-debt gap; the
 * drainer process boot/shutdown had zero unit coverage before this
 * file).
 *
 * All construction boundaries (`createDrainerWorker`,
 * `createAiGenerateWorker`, `getQueues`, `getPrisma`, `getShopifyConfig`,
 * `enqueueInitialTick`, `closeQueues`, `disconnectPrisma`) are mocked
 * via `vi.mock` + `vi.hoisted` so `main()` runs with zero real I/O.
 * `process.on` + `process.exit` are spied + no-op'd so signal handlers
 * don't leak to the host process and `process.exit(0)` doesn't kill the
 * test runner.
 *
 * Coverage matrix (the 6 required assertions per Q-B2):
 *   1. main() constructs both Workers.
 *   2. SIGTERM: both workers' close() invoked IN PARALLEL via
 *      Promise.allSettled (overlap-window assertion, not sequence).
 *   3. Shutdown order: workers → queues → prisma.
 *   4. Shutdown idempotency — second signal no-ops on the guard.
 *   5. One worker close throwing does NOT prevent the other's close
 *      and does NOT prevent queues/prisma teardown.
 *   6. process.exit(0) called AFTER all teardown resolves.
 *
 * Plus boot-side: SIGTERM + SIGINT both registered.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — must run BEFORE the index.ts import (vi.hoisted lifts
// the factory to the top of the module, ahead of static imports).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const drainerWorker = { close: vi.fn(async () => undefined) };
  const aiWorker = { close: vi.fn(async () => undefined) };
  return {
    drainerWorker,
    aiWorker,
    createDrainerWorker: vi.fn(() => drainerWorker),
    createAiGenerateWorker: vi.fn(() => aiWorker),
    enqueueInitialTick: vi.fn(async () => undefined),
    getQueues: vi.fn(() => ({
      outboxDrain: { __mock: 'outboxDrain' },
      cronRollup: { __mock: 'cronRollup' },
      cronSweep: { __mock: 'cronSweep' },
      aiGenerate: { __mock: 'aiGenerate' },
    })),
    closeQueues: vi.fn(async () => undefined),
    getPrisma: vi.fn(() => ({ __mock: 'prisma' })),
    disconnectPrisma: vi.fn(async () => undefined),
    getShopifyConfig: vi.fn(() => ({ __mock: 'shopifyConfig' })),
  };
});

vi.mock('../src/worker.js', () => ({
  createDrainerWorker: mocks.createDrainerWorker,
}));
vi.mock('../src/workers/ai-generate.worker.js', () => ({
  createAiGenerateWorker: mocks.createAiGenerateWorker,
}));
vi.mock('../src/scheduling.js', () => ({
  enqueueInitialTick: mocks.enqueueInitialTick,
}));
vi.mock('../src/db.js', () => ({
  getPrisma: mocks.getPrisma,
  disconnectPrisma: mocks.disconnectPrisma,
}));
vi.mock('@winback/queue', () => ({
  getQueues: mocks.getQueues,
  closeQueues: mocks.closeQueues,
  // createRedisClient is consumed by the (mocked) worker factories;
  // include for surface completeness in case future code paths read it.
  createRedisClient: vi.fn(() => ({ __mockRedis: true })),
}));
vi.mock('@winback/shopify', () => ({
  getShopifyConfig: mocks.getShopifyConfig,
}));

// ---------------------------------------------------------------------------
// Process spies — must be set up BEFORE main() runs so its
// `process.on('SIGTERM' / 'SIGINT')` calls go through the spy (no real
// signal handlers leak; the test runner survives `process.exit`).
// Hoisted via vi.hoisted; the spy itself lives at module top-level
// before any test imports.
// ---------------------------------------------------------------------------

const exitSpy = vi
  .spyOn(process, 'exit')
  .mockImplementation(((_code?: number) => undefined) as never);

const onSpy = vi
  .spyOn(process, 'on')
  .mockImplementation(
    ((_event: string, _listener: (...args: unknown[]) => void) =>
      process) as never,
  );

// index.ts auto-invocation is gated on NODE_ENV !== 'test' (vitest sets
// NODE_ENV=test); the import below thus does NOT trigger main(). Tests
// invoke main() explicitly.
const { main } = await import('../src/index.js');

beforeEach(() => {
  // Clears call history (counts + args) but preserves mockImplementation
  // values configured in vi.hoisted (createDrainerWorker still returns
  // the drainerWorker stub, etc.). Per-test overrides via
  // mockImplementationOnce / mockImplementation are NOT preserved.
  vi.clearAllMocks();
});

/**
 * Locate the most-recently-registered handler for `signal`, invoke it
 * (`void shutdown(signal)` — fire-and-forget), then poll for
 * `process.exit` being called as the completion signal.
 */
async function triggerSignal(signal: 'SIGTERM' | 'SIGINT'): Promise<void> {
  const signalCalls = onSpy.mock.calls.filter(([s]) => s === signal);
  expect(signalCalls.length).toBeGreaterThan(0);
  const handler = signalCalls.at(-1)![1] as () => void;
  handler();
  await vi.waitFor(
    () => {
      expect(exitSpy).toHaveBeenCalled();
    },
    { timeout: 1000 },
  );
}

// ===========================================================================
// Boot
// ===========================================================================

describe('main — boot', () => {
  it('constructs BOTH workers (createDrainerWorker + createAiGenerateWorker) — required assertion #1', async () => {
    await main();

    expect(mocks.createDrainerWorker).toHaveBeenCalledTimes(1);
    expect(mocks.createAiGenerateWorker).toHaveBeenCalledTimes(1);

    // Each Worker receives the SAME DrainerContext (prisma/queues/
    // shopifyConfig from the boot-time builders).
    // mock.calls[0] is typed as `[] | undefined` because the vi.fn factory
    // didn't get an explicit signature; cast through unknown to assert the
    // arg-tuple shape we know we passed at runtime.
    const [drainerCtx] = mocks.createDrainerWorker.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    const [aiCtx] = mocks.createAiGenerateWorker.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(drainerCtx).toBe(aiCtx);
  });

  it('enqueues the initial outbox tick onto queues.outboxDrain', async () => {
    await main();

    expect(mocks.enqueueInitialTick).toHaveBeenCalledTimes(1);
    const [arg] = mocks.enqueueInitialTick.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(arg).toMatchObject({ __mock: 'outboxDrain' });
  });

  it('registers both SIGTERM and SIGINT handlers', async () => {
    await main();

    expect(onSpy.mock.calls.filter(([s]) => s === 'SIGTERM')).toHaveLength(1);
    expect(onSpy.mock.calls.filter(([s]) => s === 'SIGINT')).toHaveLength(1);
  });
});

// ===========================================================================
// Shutdown — happy path
// ===========================================================================

describe('main — shutdown happy path', () => {
  it('SIGTERM → both workers closed IN PARALLEL via Promise.allSettled (overlap window) — required assertion #2', async () => {
    // Pin both workers' close() to overlap: each takes >0ms to
    // resolve, and the AI worker starts BEFORE the drainer worker
    // resolves. Sequential close (await first, then start second)
    // would make this impossible — aiStartedAt would always be >
    // drainerResolvedAt. Parallel close (Promise.allSettled fires
    // both synchronously, then awaits) makes aiStartedAt < both
    // workers' resolvedAt.
    let drainerStartedAt = -1;
    let drainerResolvedAt = -1;
    let aiStartedAt = -1;
    let seq = 0;
    mocks.drainerWorker.close.mockImplementation(async () => {
      drainerStartedAt = seq++;
      await new Promise((r) => setTimeout(r, 10));
      drainerResolvedAt = seq++;
    });
    mocks.aiWorker.close.mockImplementation(async () => {
      aiStartedAt = seq++;
      await new Promise((r) => setTimeout(r, 5));
    });

    await main();
    await triggerSignal('SIGTERM');

    expect(mocks.drainerWorker.close).toHaveBeenCalledTimes(1);
    expect(mocks.aiWorker.close).toHaveBeenCalledTimes(1);
    // Parallelism lock: AI close started BEFORE drainer close resolved.
    // (Sequential close would have aiStartedAt > drainerResolvedAt.)
    expect(drainerStartedAt).toBeLessThan(aiStartedAt);
    expect(aiStartedAt).toBeLessThan(drainerResolvedAt);
  });

  it('shutdown order: workers → queues → prisma — required assertion #3', async () => {
    let workerSeq = -1;
    let queuesSeq = -1;
    let prismaSeq = -1;
    let seq = 0;
    mocks.drainerWorker.close.mockImplementation(async () => {
      workerSeq = seq++;
    });
    mocks.aiWorker.close.mockImplementation(async () => undefined);
    mocks.closeQueues.mockImplementation(async () => {
      queuesSeq = seq++;
    });
    mocks.disconnectPrisma.mockImplementation(async () => {
      prismaSeq = seq++;
    });

    await main();
    await triggerSignal('SIGTERM');

    expect(workerSeq).toBeGreaterThanOrEqual(0);
    expect(queuesSeq).toBeGreaterThan(workerSeq);
    expect(prismaSeq).toBeGreaterThan(queuesSeq);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('process.exit(0) called AFTER all teardown resolves — required assertion #6', async () => {
    let prismaResolvedAt = -1;
    let exitCalledAt = -1;
    let seq = 0;
    mocks.disconnectPrisma.mockImplementation(async () => {
      prismaResolvedAt = seq++;
    });
    exitSpy.mockImplementation(((_code?: number) => {
      exitCalledAt = seq++;
      return undefined;
    }) as never);

    await main();
    await triggerSignal('SIGTERM');

    expect(prismaResolvedAt).toBeGreaterThanOrEqual(0);
    expect(exitCalledAt).toBeGreaterThan(prismaResolvedAt);
  });
});

// ===========================================================================
// Shutdown — idempotency + error isolation
// ===========================================================================

describe('main — shutdown idempotency + error isolation', () => {
  it('second signal no-ops on the shuttingDown guard — required assertion #4', async () => {
    await main();

    // Fire SIGTERM then SIGINT in quick succession. The SIGINT handler
    // calls `void shutdown('SIGINT')` which sees `shuttingDown===true`
    // and returns without running the teardown again.
    await triggerSignal('SIGTERM');

    const sigintCalls = onSpy.mock.calls.filter(([s]) => s === 'SIGINT');
    expect(sigintCalls.length).toBeGreaterThan(0);
    const sigintHandler = sigintCalls.at(-1)![1] as () => void;
    sigintHandler();
    // Let the SIGINT shutdown attempt (which will no-op) settle.
    await new Promise((r) => setTimeout(r, 20));

    // Each teardown step ran EXACTLY ONCE (from the SIGTERM-driven
    // shutdown; the SIGINT-driven shutdown short-circuited).
    expect(mocks.drainerWorker.close).toHaveBeenCalledTimes(1);
    expect(mocks.aiWorker.close).toHaveBeenCalledTimes(1);
    expect(mocks.closeQueues).toHaveBeenCalledTimes(1);
    expect(mocks.disconnectPrisma).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('drainerWorker.close() throwing does NOT prevent aiWorker.close() + queues/prisma teardown + clean exit(0) — required assertion #5', async () => {
    mocks.drainerWorker.close.mockImplementation(async () => {
      throw new Error('drainer worker close blew up');
    });

    await main();
    await triggerSignal('SIGTERM');

    expect(mocks.drainerWorker.close).toHaveBeenCalledTimes(1);
    // Other worker still closed (Promise.allSettled isolation).
    expect(mocks.aiWorker.close).toHaveBeenCalledTimes(1);
    // Downstream teardown still ran.
    expect(mocks.closeQueues).toHaveBeenCalledTimes(1);
    expect(mocks.disconnectPrisma).toHaveBeenCalledTimes(1);
    // Clean exit despite the worker-close error (shutdown swallows it
    // via Promise.allSettled; the per-step try/catch covers queues +
    // prisma).
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('aiWorker.close() throwing does NOT prevent drainerWorker.close() + queues/prisma teardown + clean exit(0) — required assertion #5 (mirror)', async () => {
    mocks.aiWorker.close.mockImplementation(async () => {
      throw new Error('ai-generate worker close blew up');
    });

    await main();
    await triggerSignal('SIGTERM');

    expect(mocks.drainerWorker.close).toHaveBeenCalledTimes(1);
    expect(mocks.aiWorker.close).toHaveBeenCalledTimes(1);
    expect(mocks.closeQueues).toHaveBeenCalledTimes(1);
    expect(mocks.disconnectPrisma).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('closeQueues() throwing does NOT prevent disconnectPrisma() + clean exit(0)', async () => {
    mocks.closeQueues.mockImplementation(async () => {
      throw new Error('closeQueues blew up');
    });

    await main();
    await triggerSignal('SIGTERM');

    expect(mocks.disconnectPrisma).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
