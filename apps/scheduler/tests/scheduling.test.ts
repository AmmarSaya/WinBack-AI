/**
 * Scheduling unit tests.
 *
 * Locks the BullMQ repeat-option shape per queue:
 *
 *   - cron.rollup → `repeat: { pattern: '0 * * * *' }` (cron syntax)
 *   - cron.sweep  → `repeat: { every: 900000 }`        (interval ms)
 *
 * A regression that swaps these (rollup ends up on interval, sweep ends
 * up on pattern) is caught here. The two distinct mechanisms have very
 * different operational semantics (wall-clock vs. since-startup) and
 * silently flipping one would shift cron behavior in a hard-to-debug way.
 */

import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import {
  ROLLUP_CRON_PATTERN,
  ROLLUP_JOB_NAME,
  SWEEP_DECAY_CRON_PATTERN,
  SWEEP_DECAY_JOB_NAME,
  SWEEP_DISPATCH_JOB_NAME,
  SWEEP_ENRICHMENT_JOB_NAME,
  SWEEP_INTERVAL_MS,
  registerDecaySweepRepeat,
  registerDispatchSweepRepeat,
  registerRollupRepeat,
  registerSweepRepeat,
} from '../src/scheduling.js';

function makeStubQueue(): { queue: Queue; addMock: ReturnType<typeof vi.fn> } {
  const addMock = vi.fn().mockResolvedValue(undefined);
  return {
    queue: { add: addMock } as unknown as Queue,
    addMock,
  };
}

describe('registerRollupRepeat', () => {
  it('calls queue.add with cron PATTERN (NOT interval) for hourly UTC at minute 0', async () => {
    const { queue, addMock } = makeStubQueue();
    await registerRollupRepeat(queue);

    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith(
      ROLLUP_JOB_NAME,
      {},
      { repeat: { pattern: ROLLUP_CRON_PATTERN } },
    );
  });

  it('the cron pattern is exactly "0 * * * *" (regression lock)', () => {
    expect(ROLLUP_CRON_PATTERN).toBe('0 * * * *');
  });
});

describe('registerSweepRepeat', () => {
  it('calls queue.add with INTERVAL MS (NOT cron pattern) for 15-minute sweep', async () => {
    const { queue, addMock } = makeStubQueue();
    await registerSweepRepeat(queue);

    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith(
      SWEEP_ENRICHMENT_JOB_NAME,
      {},
      { repeat: { every: SWEEP_INTERVAL_MS } },
    );
  });

  it('the sweep interval is exactly 15 minutes in ms (regression lock)', () => {
    expect(SWEEP_INTERVAL_MS).toBe(15 * 60 * 1000);
    expect(SWEEP_INTERVAL_MS).toBe(900000);
  });
});

describe('registerDecaySweepRepeat', () => {
  it('calls queue.add with cron PATTERN (NOT interval) for the daily 03:00 UTC decay sweep', async () => {
    const { queue, addMock } = makeStubQueue();
    await registerDecaySweepRepeat(queue);

    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith(
      SWEEP_DECAY_JOB_NAME,
      {},
      { repeat: { pattern: SWEEP_DECAY_CRON_PATTERN } },
    );
  });

  it('the decay cron pattern is exactly "0 3 * * *" (daily 03:00 UTC — regression lock)', () => {
    expect(SWEEP_DECAY_CRON_PATTERN).toBe('0 3 * * *');
  });

  it('the decay sweep job name is distinct from the enrichment sweep (both on cron.sweep)', () => {
    expect(SWEEP_DECAY_JOB_NAME).toBe('decay-sweep');
    expect(SWEEP_DECAY_JOB_NAME).not.toBe(SWEEP_ENRICHMENT_JOB_NAME);
  });
});

describe('registerDispatchSweepRepeat', () => {
  it('calls queue.add with INTERVAL MS (NOT cron pattern) for the 15-min dispatch sweep', async () => {
    const { queue, addMock } = makeStubQueue();
    await registerDispatchSweepRepeat(queue);

    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith(
      SWEEP_DISPATCH_JOB_NAME,
      {},
      { repeat: { every: SWEEP_INTERVAL_MS } },
    );
  });

  it('the dispatch sweep job name is "dispatch-sweep" and distinct from the other sweeps (all on cron.sweep)', () => {
    expect(SWEEP_DISPATCH_JOB_NAME).toBe('dispatch-sweep');
    expect(SWEEP_DISPATCH_JOB_NAME).not.toBe(SWEEP_ENRICHMENT_JOB_NAME);
    expect(SWEEP_DISPATCH_JOB_NAME).not.toBe(SWEEP_DECAY_JOB_NAME);
  });
});

describe('regression — pattern vs every distinction must not flip', () => {
  it('rollup option uses `pattern`, sweep option uses `every`, decay uses `pattern`', async () => {
    const rollup = makeStubQueue();
    const sweep = makeStubQueue();
    const decay = makeStubQueue();

    await registerRollupRepeat(rollup.queue);
    await registerSweepRepeat(sweep.queue);
    await registerDecaySweepRepeat(decay.queue);

    const rollupOpts = rollup.addMock.mock.calls[0]?.[2] as { repeat: Record<string, unknown> };
    const sweepOpts = sweep.addMock.mock.calls[0]?.[2] as { repeat: Record<string, unknown> };
    const decayOpts = decay.addMock.mock.calls[0]?.[2] as { repeat: Record<string, unknown> };

    expect(rollupOpts.repeat).toHaveProperty('pattern');
    expect(rollupOpts.repeat).not.toHaveProperty('every');
    expect(sweepOpts.repeat).toHaveProperty('every');
    expect(sweepOpts.repeat).not.toHaveProperty('pattern');
    // Decay is calendar-anchored → cron pattern, NOT interval.
    expect(decayOpts.repeat).toHaveProperty('pattern');
    expect(decayOpts.repeat).not.toHaveProperty('every');
  });
});
