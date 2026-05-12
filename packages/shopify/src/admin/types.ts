/**
 * Shopify GraphQL Admin API cost throttling.
 *
 * Shopify uses a per-shop leaky bucket. Every query has a calculated cost.
 * `extensions.cost.throttleStatus` in every response reports the bucket
 * state — our CostTracker consumes it as the authoritative source.
 *
 *   maximumAvailable    bucket size (1000 standard, 2000 Plus typically)
 *   currentlyAvailable  current bucket level
 *   restoreRate         points refilled per second
 */
export interface ThrottleStatus {
  readonly maximumAvailable: number;
  readonly currentlyAvailable: number;
  readonly restoreRate: number;
}

export interface ShopBucketState {
  readonly maximumAvailable: number;
  readonly currentlyAvailable: number;
  readonly restoreRate: number;
  /** Unix ms when this state was recorded; used for time-based refill. */
  readonly observedAt: number;
}
