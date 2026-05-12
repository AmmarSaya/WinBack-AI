import { describe, expect, it } from 'vitest';

import { CostTracker } from '../src/admin/cost-tracker.js';

const SHOP = 'foo.myshopify.com';

/** Mutable time source for deterministic testing. */
function mockClock(initial = 0) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

describe('CostTracker — empty state', () => {
  it('assumes full bucket before any response is observed', () => {
    const clock = mockClock();
    const tracker = new CostTracker({ now: clock.now, safetyFloor: 0 });
    expect(tracker.msUntilAvailable(SHOP, 500)).toBe(0);
  });

  it('snapshot returns null before any observation', () => {
    const tracker = new CostTracker();
    expect(tracker.snapshot(SHOP)).toBeNull();
  });
});

describe('CostTracker — onResponse', () => {
  it('uses observed throttleStatus values', () => {
    const clock = mockClock();
    const tracker = new CostTracker({ now: clock.now, safetyFloor: 0 });
    tracker.onResponse(SHOP, {
      maximumAvailable: 1000,
      currentlyAvailable: 300,
      restoreRate: 50,
    });
    // Available immediately = 300. Query cost 100 → fits.
    expect(tracker.msUntilAvailable(SHOP, 100)).toBe(0);
    // Query cost 500 → deficit 200, restoreRate 50/s → 4000ms.
    expect(tracker.msUntilAvailable(SHOP, 500)).toBe(4000);
  });

  it('respects safetyFloor (cost + floor must fit)', () => {
    const clock = mockClock();
    const tracker = new CostTracker({ now: clock.now, safetyFloor: 50 });
    tracker.onResponse(SHOP, {
      maximumAvailable: 1000,
      currentlyAvailable: 100,
      restoreRate: 50,
    });
    // Available 100; cost 50 needs 100 (50 + floor 50) → fits exactly.
    expect(tracker.msUntilAvailable(SHOP, 50)).toBe(0);
    // Cost 51 needs 101 → deficit 1, wait 20ms.
    expect(tracker.msUntilAvailable(SHOP, 51)).toBe(20);
  });
});

describe('CostTracker — refill over elapsed time', () => {
  it('refills currentAvailable at restoreRate per second', () => {
    const clock = mockClock(0);
    const tracker = new CostTracker({ now: clock.now, safetyFloor: 0 });
    tracker.onResponse(SHOP, {
      maximumAvailable: 1000,
      currentlyAvailable: 0,
      restoreRate: 50,
    });
    // 1 second elapsed → 50 available.
    clock.advance(1000);
    expect(tracker.msUntilAvailable(SHOP, 50)).toBe(0);
    expect(tracker.msUntilAvailable(SHOP, 100)).toBe(1000);
  });

  it('caps refill at maximumAvailable', () => {
    const clock = mockClock(0);
    const tracker = new CostTracker({ now: clock.now, safetyFloor: 0 });
    tracker.onResponse(SHOP, {
      maximumAvailable: 1000,
      currentlyAvailable: 800,
      restoreRate: 50,
    });
    // 100 seconds elapsed → would be 5800, but capped at 1000.
    clock.advance(100_000);
    expect(tracker.msUntilAvailable(SHOP, 1000)).toBe(0);
  });
});

describe('CostTracker — onThrottled', () => {
  it('zeros bucket and requires wait based on elapsed time', () => {
    const clock = mockClock(0);
    const tracker = new CostTracker({ now: clock.now, safetyFloor: 0 });
    tracker.onResponse(SHOP, {
      maximumAvailable: 1000,
      currentlyAvailable: 500,
      restoreRate: 50,
    });
    tracker.onThrottled(SHOP);
    // Immediate retry of cost 50 → deficit 50, 1000ms.
    expect(tracker.msUntilAvailable(SHOP, 50)).toBe(1000);
  });

  it('preserves max/restoreRate from prior observations', () => {
    const clock = mockClock();
    const tracker = new CostTracker({ now: clock.now });
    tracker.onResponse(SHOP, {
      maximumAvailable: 2000,
      currentlyAvailable: 100,
      restoreRate: 100,
    });
    tracker.onThrottled(SHOP);
    const snap = tracker.snapshot(SHOP);
    expect(snap?.maximumAvailable).toBe(2000);
    expect(snap?.restoreRate).toBe(100);
    expect(snap?.currentlyAvailable).toBe(0);
  });
});

describe('CostTracker — reserve', () => {
  it('decrements local bucket optimistically', () => {
    const clock = mockClock();
    const tracker = new CostTracker({ now: clock.now, safetyFloor: 0 });
    tracker.onResponse(SHOP, {
      maximumAvailable: 1000,
      currentlyAvailable: 500,
      restoreRate: 50,
    });
    tracker.reserve(SHOP, 200);
    // 500 - 200 = 300 immediately available.
    expect(tracker.snapshot(SHOP)?.currentlyAvailable).toBe(300);
    expect(tracker.msUntilAvailable(SHOP, 250)).toBe(0);
    expect(tracker.msUntilAvailable(SHOP, 301)).toBeGreaterThan(0);
  });

  it('creates initial state from defaults if no observation yet', () => {
    const tracker = new CostTracker({ safetyFloor: 0 });
    tracker.reserve(SHOP, 100);
    const snap = tracker.snapshot(SHOP);
    expect(snap?.maximumAvailable).toBe(1000);
    expect(snap?.currentlyAvailable).toBe(900);
  });
});

describe('CostTracker — multi-shop isolation', () => {
  it('shops have independent state', () => {
    const tracker = new CostTracker({ safetyFloor: 0 });
    tracker.onResponse('a.myshopify.com', {
      maximumAvailable: 1000,
      currentlyAvailable: 100,
      restoreRate: 50,
    });
    tracker.onResponse('b.myshopify.com', {
      maximumAvailable: 2000,
      currentlyAvailable: 1500,
      restoreRate: 100,
    });
    expect(tracker.snapshot('a.myshopify.com')?.currentlyAvailable).toBe(100);
    expect(tracker.snapshot('b.myshopify.com')?.currentlyAvailable).toBe(1500);
    tracker.onThrottled('a.myshopify.com');
    expect(tracker.snapshot('b.myshopify.com')?.currentlyAvailable).toBe(1500);
  });
});

describe('CostTracker — reset', () => {
  it('clears specific shop', () => {
    const tracker = new CostTracker();
    tracker.onResponse(SHOP, {
      maximumAvailable: 1000,
      currentlyAvailable: 100,
      restoreRate: 50,
    });
    tracker.reset(SHOP);
    expect(tracker.snapshot(SHOP)).toBeNull();
  });

  it('clears all shops when called with no arg', () => {
    const tracker = new CostTracker();
    tracker.onResponse('a.myshopify.com', {
      maximumAvailable: 1000,
      currentlyAvailable: 100,
      restoreRate: 50,
    });
    tracker.onResponse('b.myshopify.com', {
      maximumAvailable: 1000,
      currentlyAvailable: 100,
      restoreRate: 50,
    });
    tracker.reset();
    expect(tracker.snapshot('a.myshopify.com')).toBeNull();
    expect(tracker.snapshot('b.myshopify.com')).toBeNull();
  });
});
