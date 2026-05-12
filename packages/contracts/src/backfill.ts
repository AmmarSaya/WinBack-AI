/**
 * Canonical registry of backfill resource identifiers. Producers (the
 * BackfillRunner caller, the BackfillJobRepository methods, the per-
 * resource fetcher/processor pairs) MUST reference a constant from this
 * object — never a string literal.
 *
 * Adding a resource is a TS-only change here; the DB column is a String
 * so no migration is required. A check constraint on format may land in
 * a future B-stage migration if defense-in-depth becomes needed.
 *
 * This is the same pattern used for OUTBOX_EVENTS.type — typed registry
 * over ad-hoc literals.
 */
export const BACKFILL_RESOURCES = {
  customers: 'customers',
  orders: 'orders',
  products: 'products',
} as const;

export type BackfillResource =
  (typeof BACKFILL_RESOURCES)[keyof typeof BACKFILL_RESOURCES];

export const ALL_BACKFILL_RESOURCES: ReadonlySet<BackfillResource> = new Set(
  Object.values(BACKFILL_RESOURCES) as BackfillResource[],
);

export function isBackfillResource(value: string): value is BackfillResource {
  return ALL_BACKFILL_RESOURCES.has(value as BackfillResource);
}
