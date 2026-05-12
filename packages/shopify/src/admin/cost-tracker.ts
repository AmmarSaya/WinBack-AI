import type { ShopBucketState, ThrottleStatus } from './types.js';

/**
 * Per-shop leaky-bucket cost tracker for the Shopify GraphQL Admin API.
 *
 * Pure state machine — no I/O, no network. All time is read from an
 * injectable `now()` so tests are deterministic.
 *
 * Authoritative source is Shopify's response: every successful call's
 * `extensions.cost.throttleStatus` overwrites our local belief. Between
 * calls, we extrapolate via the observed `restoreRate`. The local
 * `reserve` step is an optimistic decrement so concurrent requests don't
 * burst over budget before Shopify's response lands.
 *
 * Why "first deliverable" (per the C4 guardrail): if backfill (C5)
 * issues queries without this gate, every shop's first burst hits 429
 * and the retry loop's behavior — not the throttle itself — determines
 * whether backfill completes in 10 minutes or 10 hours. The wait math
 * has to be tested in isolation BEFORE any network code can call it.
 */

export interface CostTrackerOptions {
  /** Bucket size assumed before any response is observed. Default 1000. */
  readonly defaultMax?: number;
  /** Refill rate assumed before any response is observed. Default 50/s. */
  readonly defaultRestoreRate?: number;
  /**
   * Safety floor — never let `available` cross below this even if Shopify
   * would technically allow. Buys headroom for concurrent requests that
   * haven't observed the latest throttleStatus yet. Default 50.
   */
  readonly safetyFloor?: number;
  /** Source of "now" in unix ms. Injectable for deterministic tests. */
  readonly now?: () => number;
}

const DEFAULTS = {
  defaultMax: 1000,
  defaultRestoreRate: 50,
  safetyFloor: 50,
} as const;

export class CostTracker {
  private readonly state = new Map<string, ShopBucketState>();
  private readonly defaultMax: number;
  private readonly defaultRestoreRate: number;
  private readonly safetyFloor: number;
  private readonly now: () => number;

  constructor(options: CostTrackerOptions = {}) {
    this.defaultMax = options.defaultMax ?? DEFAULTS.defaultMax;
    this.defaultRestoreRate = options.defaultRestoreRate ?? DEFAULTS.defaultRestoreRate;
    this.safetyFloor = options.safetyFloor ?? DEFAULTS.safetyFloor;
    this.now = options.now ?? (() => Date.now());
  }

  /** Updates state from a Shopify response's throttleStatus block. */
  onResponse(shop: string, status: ThrottleStatus): void {
    this.state.set(shop, { ...status, observedAt: this.now() });
  }

  /**
   * Marks the shop as throttled — sets `currentlyAvailable` to zero so the
   * next wait computation uses real-elapsed-time refill.
   */
  onThrottled(shop: string, status?: ThrottleStatus): void {
    const prior = this.state.get(shop);
    const base: ThrottleStatus = status ?? {
      maximumAvailable: prior?.maximumAvailable ?? this.defaultMax,
      currentlyAvailable: 0,
      restoreRate: prior?.restoreRate ?? this.defaultRestoreRate,
    };
    this.state.set(shop, {
      ...base,
      currentlyAvailable: 0,
      observedAt: this.now(),
    });
  }

  /**
   * Computes wait time before issuing a query of `cost` against `shop`.
   * Returns 0 if it can proceed now.
   *
   * `available_now = stored.currentlyAvailable + elapsedSec * restoreRate`
   * (capped at `maximumAvailable`).
   * If `available_now >= cost + safetyFloor` → 0
   * Else → milliseconds to wait for the deficit to refill.
   */
  msUntilAvailable(shop: string, cost: number): number {
    const projected = this.projectedAvailable(shop);
    const required = cost + this.safetyFloor;
    if (projected.available >= required) return 0;
    const deficit = required - projected.available;
    return Math.ceil((deficit / projected.restoreRate) * 1000);
  }

  /**
   * Optimistic local reserve before issuing a request. The next
   * `onResponse` overwrites with Shopify's authoritative value. Local
   * reserves only matter when two requests race before either has seen
   * a response back.
   */
  reserve(shop: string, cost: number): void {
    const projected = this.projectedAvailable(shop);
    this.state.set(shop, {
      maximumAvailable: projected.max,
      currentlyAvailable: Math.max(0, projected.available - cost),
      restoreRate: projected.restoreRate,
      observedAt: this.now(),
    });
  }

  /** Read-only snapshot for metrics/debugging. */
  snapshot(shop: string): ShopBucketState | null {
    return this.state.get(shop) ?? null;
  }

  /** Test/maintenance reset. Omitting `shop` clears all state. */
  reset(shop?: string): void {
    if (shop === undefined) this.state.clear();
    else this.state.delete(shop);
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private projectedAvailable(shop: string): {
    available: number;
    max: number;
    restoreRate: number;
  } {
    const stored = this.state.get(shop);
    const max = stored?.maximumAvailable ?? this.defaultMax;
    const restoreRate = stored?.restoreRate ?? this.defaultRestoreRate;
    if (stored === undefined) {
      return { available: max, max, restoreRate };
    }
    const elapsedSec = Math.max(0, (this.now() - stored.observedAt) / 1000);
    const available = Math.min(max, stored.currentlyAvailable + elapsedSec * restoreRate);
    return { available, max, restoreRate };
  }
}
