# Epic E Session 2 — Customer Scoring, State Machine, State-Change Producer

**Status:** DRAFT — awaiting senior review approval before any schema or repository code is written. All 6 design Q-locks from session-start confirmed.
**Scope:** RFM scoring + `CustomerScore` table + `Customer.state` writer + `customer.state_changed` outbox event producer. Triggers inline in the drainer's order + customer upsert paths.
**Companion docs:** [ARCHITECTURE.md](ARCHITECTURE.md) (locked policies), [CP2-ATTRIBUTION-CONTRACT.md](CP2-ATTRIBUTION-CONTRACT.md) (inline-in-tx pattern source), [EPIC-E-FIELD-MAPPING.md](EPIC-E-FIELD-MAPPING.md) (session 1 contract).
**Schema reference:** [packages/db/prisma/schema.prisma](packages/db/prisma/schema.prisma) at `main` SHA `e85f5d3`.

This document is a permanent contract. Any future change to scoring, state assignment, or the `customer.state_changed` payload MUST update this file in the same commit.

---

## Locked design decisions (read first)

These came out of the session-start design pass. Each is locked unless a written counter-proposal lands here first.

| Q | Lock | Source |
|---|---|---|
| Q1 — RFM window | **Trailing 365d for F and M; R is now-relative all-time** | session-start lock |
| Q2 — Scoring scheme | **Quintiles 1–5 per dimension; new `insufficient_data` state when merchant has <5 customers with paid orders** | session-start lock |
| Q3 — `CustomerScore` shape | **Single row per `(merchantId, customerId)`; history lives in `AuditLog` + `customer.state_changed` outbox events** | session-start lock |
| Q4 — State machine | **Recency-driven hard boundaries; no per-merchant overrides v1** | session-start lock |
| Q5 — Trigger path | **Inline in drainer tick, same tx as Order/Customer upsert** | CP-2 §Q1 pattern; session-start lock |
| Q6 — Outbox payload | **`{ merchantId, customerId, shopifyCustomerId, oldState, newState, computedAt, rfmScore: { rDays, fCount, mCents, rQuintile, fQuintile, mQuintile } }`** | session-start lock |

---

## Policy decisions

These rules apply across the scoring/state subsystem. Per-detail decisions defer to per-policy where conflicts arise.

### S-1 — RFM compute uses paid, non-test orders only

The customer base for scoring is `Order WHERE financialStatus = 'paid' AND isTest = false`. Cancelled, refunded, or pending orders do NOT count toward F or M. `Order.deletedAt IS NULL` is enforced automatically by the Prisma soft-delete extension. The filter is applied at the source query — never trust the caller to pre-filter.

- **Refunded orders** (`financial_status` ∈ {`refunded`, `partially_refunded`}) are excluded from F/M. A customer whose only order was fully refunded scores as if they never ordered. Partial refunds are NOT adjusted out of `mCents` in v1 — the full original `totalAmountCents` counts. Reason: H1 attribution does the refund-adjusted math at the rollup layer; RFM scoring uses original order intent. Documented for symmetry with CP-2 §Q2(d).
- **Cancelled orders** (`Order.cancelledAt IS NOT NULL`) are excluded by the financial-status filter — Shopify sets `financial_status: voided` or `refunded` on cancel.

### S-2 — Recency is always now-relative all-time, never window-bounded

`R = floor((now - lastPaidOrderAt) / 86400000)` in days. `lastPaidOrderAt = MAX(shopifyProcessedAt ?? placedAt)` across the customer's paid orders, all-time. NOT capped at 365d. A customer's last paid order was 800 days ago → `R = 800`.

If a customer has no paid orders, R falls back to `floor((now - Customer.shopifyCreatedAt) / 86400000)` — account-age proxy. Documented in S-7 (Lurker handling) below.

`now` is captured ONCE at the start of the scoring transaction (`new Date()` inside the tx callback). Every customer in the merchant cohort during one recompute pass uses the same `now` so quintiles are consistent.

### S-3 — Frequency and Monetary are trailing-365d

```
F = COUNT(Order WHERE
          merchantId = $1
          AND customerId = $customerId
          AND financialStatus = 'paid'
          AND isTest = false
          AND placedAt >= now - 365·86400000)
M = SUM(Order.totalAmountCents WHERE
          /* same filter as F */)
```

`Order.totalAmountCents` is shop-currency per schema; M is therefore in shop currency. `Merchant.shopCurrency` is denormalized onto `CustomerScore.currency` at compute time for downstream Epic G/F consumers (avoids a JOIN every read).

Multi-currency stores: `Order.totalAmountCents` is the shop-currency value Shopify computed at order time (`total_price_set.shop_money.amount`). M aggregates cleanly in shop currency. The presentment side stays in `Order.presentmentTotalCents` and is NOT used for scoring.

### S-4 — Quintiles are per-merchant, per-dimension, computed inline against the live cohort

At each recompute (inline in the drainer tick for a single customer), the algorithm:

1. Reads R, F, M for every Customer in the merchant where the customer has ≥1 paid order in the trailing 365d window (the "scorable cohort").
2. If `|scorable cohort| < 5`: returns early. Customer's state = `insufficient_data`. No quintiles, no churn risk.
3. Sorts the cohort's R values ascending. R-quintile boundaries = values at 20/40/60/80 percentiles. Lower R (more recent) = higher quintile (better customer).
4. Sorts F values ascending. F-quintile boundaries at 20/40/60/80 percentiles. Higher F = higher quintile.
5. Sorts M values ascending. M-quintile boundaries at 20/40/60/80 percentiles. Higher M = higher quintile.
6. Assigns this customer's R/F/M quintiles by binary-searching their values against the boundary array.
7. Computes `churnRiskScore = 1 - ((rQuintile + fQuintile + mQuintile) / 15)`. Range `[0, 1]`. Higher = more likely to churn. `(5+5+5)/15 = 1.0` → score `0.0`. `(1+1+1)/15 = 0.2` → score `0.8`.

**Tie-break.** Two customers at the same R (or F, or M) value land in adjacent quintiles depending on sort position. Prisma's default sort is stable on the integer value; ties resolve by `customerId` ascending (lexicographic). For v1 this is acceptable — the only observable consequence is one customer's quintile differs by 1 from a peer with identical R/F/M.

**Cost.** Each recompute runs the cohort aggregation query (raw SQL `GROUP BY customerId` against `Order`) for the merchant, returning `N` rows where `N` = merchant's scorable customer count. For a merchant with 1k–10k customers, this is sub-100ms in Postgres given the existing `@@index([merchantId, placedAt])` and `@@index([merchantId, customerId])` on `Order`. For >10k, latency grows; document the scale ceiling in S-10. Boundary caching is deferred to a future session. **Do NOT read from existing `CustomerScore` rows — circular and stale; see the `readCohort` docstring.**

### S-5 — State assignment is purely recency-driven; boundaries hard-coded v1

`Customer.state` derives from `R` via the following table. Hard boundaries; no per-merchant overrides.

| R (days since last paid order) | State |
|---|---|
| Customer in `insufficient_data` cohort (per S-4) | `insufficient_data` |
| `R ≤ 30` | `active` |
| `30 < R ≤ 90` | `warm` |
| `90 < R ≤ 180` | `at_risk` |
| `180 < R ≤ 365` | `dormant` |
| `R > 365` | `lost` |

**Adding `insufficient_data` to `CustomerState` enum is a schema migration in session 2.** Postgres enum value addition is non-breaking (`ALTER TYPE ... ADD VALUE`). The default stays `active` — new customers without scoring data, on a merchant with ≥5 scorable customers, are `active` until their first recompute.

**Hard boundaries lock.** Per Q4, no `MerchantSettings.scoringRWarmDays` / `scoringRAtRiskDays` / etc. row v1. If post-launch data shows different merchant verticals need different cadences (e.g., apparel vs. SaaS subscription), schema additions land then. Documented to forestall the "let's make it configurable upfront" reflex.

### S-6 — Lurker handling (customer with no paid orders)

A customer who created their account but never placed a paid order has no defined R/F/M from the order table. The compute treats them as follows:

- **If the merchant's scorable cohort has <5 customers:** `state = insufficient_data`, no scores stored. Same as everyone else in the merchant.
- **If the merchant's scorable cohort has ≥5:** the customer is NOT included in the cohort (they have zero paid orders, would skew the boundaries). They DO get a `CustomerScore` row with:
  - `rDays = floor((now - Customer.shopifyCreatedAt) / 86400000)` — account age in days
  - `fCount = 0`
  - `mCents = 0n`
  - `rQuintile = null` (not in the scoring cohort)
  - `fQuintile = null`
  - `mQuintile = null`
  - `churnRiskScore = null`
  - State assigned from `rDays` (account-age R) via the S-5 boundary table

Reason: lurkers carry account-age signal that downstream Epic G/F might use to message "you signed up 90 days ago, here's a welcome offer" without bucketing them as engaged customers. The null quintiles signal "not actually scored" to consumers; the state band still gives Epic G the categorical signal.

If Epic G later wants a dedicated `prospect` state for lurkers, add the enum value then. v1 keeps the surface small.

### S-7 — Scoring is inline in the drainer tx, NOT a separate outbox event

Per Q5 lock + CP-2 §Q1 pattern. The drainer's order + customer upsert handlers call the scoring service AFTER the Order/Customer write and BEFORE the tx commit. Atomic.

```
withTenantScope({ merchantId }, async () => {
  await prisma.$transaction(async (tx) => {
    const { customerId, isNewOrder, qualifyingTransition, ... } =
      await orderRepo.upsertFromWebhook({ merchantId, body, tx });

    if (customerId) {
      await customerScoreService.recompute({
        merchantId,
        customerId,
        tx,
      });
      // Inside recompute: if state changes, writes:
      //   1. Customer.state update
      //   2. CustomerScore upsert
      //   3. AuditLog row (customer.state_changed)
      //   4. OutboxEvent row (customer.state_changed)
      // All using the same tx argument.
    }
  });
});
```

**Triggers** that call recompute:
- `order.placed` → after Order upsert (every paid+non-paid; recompute may be a no-op if non-paid)
- `order.updated` → after Order upsert (financial-status transitions matter)
- `customer.created` → after Customer upsert (initial score for the new customer)
- `customer.updated` → after Customer upsert (rare R/F/M change, but consent flips, etc., shouldn't trigger; **only triggered if the Customer write affected scoring-relevant fields**; v1 simplification: always recompute on customer.updated, accept the cost)
- `customer.deleted` → soft-deletes Customer; recompute is SKIPPED. The customer row's `deletedAt IS NOT NULL` excludes it from future cohort reads via the soft-delete extension.

**Triggers that do NOT call recompute:**
- `customer.redacted` (GDPR) — already handled in apps/web's redact processor; the customer row is wiped + soft-deleted. Same as customer.deleted.
- `customer.state_changed` (our own outbox event) — would be a loop. The drainer's existing routing for this event continues to `handleNoop` post-session-2; it's emitted for downstream Epic G consumers only.
- `merchant.installed` / `gdpr.shop_redacted` — no per-customer scoring relevance.

### S-8 — `customer.state_changed` is emitted ONLY when state actually changes

Recompute writes a `CustomerScore` row every time (to keep `computedAt` fresh). State change is detected by `oldState !== newState` before writing the outbox event. If the customer was `active` and stays `active`, no event. If they transition `active → warm`, one event. Idempotent on replay because the outbox event's payload includes `computedAt` — consumers (Epic G winback flows) key off the transition, not the recompute timestamp.

**Initial-scoring case.** A brand-new customer arrives via `customer.created`. Their pre-recompute state is the schema default `active` (from `@default(active)`). After recompute, if they land back in `active`, no event. If they land in `insufficient_data` (merchant has <5 scorable), no event (default→default-equivalent suppression; documented). If they land in `warm`/`at_risk`/`dormant`/`lost`... that's atypical for a brand-new customer (only happens if `shopifyCreatedAt` is months in the past — e.g. historical-customer backfill via S-9), and a state-changed event fires.

**Re-installed merchant case (out of scope).** A merchant uninstalls, re-installs, customer rows are recreated → `Customer.state = active` default → recompute runs → emits state-changed event for every customer with non-active state. Acceptable behavior; documented for future operator runbook.

### S-9 — Backfill is OUT of scope for session 2

The C5 customer/order backfill runner exists in `@winback/shopify`. Triggering scoring during backfill is intentionally NOT done in session 2. Backfill writes Customer and Order rows but does NOT call the scoring service. After backfill completes, the operator runs a one-shot bulk-rescore (deferred — operator CLI subcommand, ships when first merchant needs it).

Reason: backfill processes thousands of customers in one job. Inline scoring during backfill would call recompute N² times (each customer's recompute reads the whole cohort, which is still being built). Order matters: backfill all customers first, THEN run a bulk recompute pass. v1 ships the inline drainer recompute; the bulk operator path is a follow-up.

CP-2 §Q1 has the analogous lock for AttributionEvent ("backfill never fires attribution"); S-9 is the scoring equivalent.

### S-10 — Scale ceiling for inline recompute is ~10k scorable customers per merchant

Each recompute runs the cohort aggregation query (raw SQL `GROUP BY customerId` against `Order` — see `readCohort` docstring) and gets back N rows. At N = 10k scorable customers, the `GROUP BY` + sort completes in ~50–100ms given the `@@index([merchantId, placedAt])` and `@@index([merchantId, customerId])` indexes on `Order`. At N = 100k, the aggregation pushes 500ms–1s — too slow for the drainer's per-event budget (Shopify's 5s ack budget already used at ingest; drainer ticks have ~10s before becoming visible-late).

**Mitigation when crossed:** per-merchant cached `QuintileBoundaries` table, recomputed daily by D3 scheduler. Inline recompute reads cached boundaries + this customer's R/F/M only (constant-time). Schema change at the time, not now.

**Observability for the ceiling:** scoring service emits structured log `customer_score.recompute.duration_ms` with `{ merchantId, cohortSize }`. Operator dashboards plot p95 by merchant; alert when any merchant crosses 200ms p95.

### S-11 — Currency snapshotted onto CustomerScore at compute time

`CustomerScore.currency` = `Merchant.shopCurrency` at the recompute timestamp. Denormalized so consumers reading CustomerScore don't JOIN to Merchant.

Edge case: merchant changes their Shopify shop currency (rare; some platforms allow it). The next recompute writes the new currency on the row. Historical state-changed outbox events still carry the old currency in `rfmScore.mCents` — Epic G consumers should treat these as forensic forensically (snapshot of the moment) not "current state."

---

## CustomerScore table schema

New table, added in a single migration `<timestamp>_epic_e_session_2_customer_score.sql`. CASCADE on Merchant + Customer deletion per locked decision #13.

```prisma
model CustomerScore {
  id         String   @id @default(cuid())
  merchantId String
  customerId String

  /* RFM raw values */
  rDays      Int                 // days since last paid order (or account-age fallback per S-6)
  fCount     Int                 // paid orders in trailing 365d
  mCents     BigInt              // SUM(totalAmountCents) in trailing 365d, shop currency
  currency   String   @db.Char(3) // Merchant.shopCurrency snapshot at compute time

  /* RFM quintiles — null for insufficient_data merchants + lurkers */
  rQuintile      Int?            // 1-5 (5 = best, most recent)
  fQuintile      Int?            // 1-5 (5 = best, highest frequency)
  mQuintile      Int?            // 1-5 (5 = best, highest spend)
  churnRiskScore Float?   @db.DoublePrecision  // 0.0-1.0 (0 = best, 1 = worst). Null when any quintile is null. Float8/double precision so the 0.0–1.0 range has full mantissa; Float4 (Postgres default) loses precision past ~7 significant digits.

  /* Audit trail */
  computedAt DateTime            // Date.now() at the recompute call site
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  merchant   Merchant @relation(fields: [merchantId], references: [id], onDelete: Cascade)
  customer   Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)

  @@unique([merchantId, customerId])
  @@index([merchantId, churnRiskScore(sort: Desc)])  // "show me my top at-risk customers"
  @@index([merchantId, computedAt])                  // staleness scans for the bulk rescore op
}
```

**Indexes rationale:**
- `@@unique([merchantId, customerId])` — primary idempotency guard; one row per customer.
- `@@index([merchantId, churnRiskScore DESC])` — Epic E session 3 / Epic G dashboards filter "at-risk customers" by descending score within a merchant. The DESC index avoids a sort.
- `@@index([merchantId, computedAt])` — operator bulk-rescore (S-9 follow-up) reads stale rows: `WHERE merchantId=$1 AND computedAt < $cutoff`.

**No CHECK constraints v1.** Quintile values are `Int?` 1–5; enforce via Zod at the repository layer rather than DB CHECK. Reasoning: matching the existing T4/T5 pattern (CHECK only for invariants we want DB-enforced; quintile bounds are a business-logic invariant, not a corruption-protection invariant).

---

## Customer.state enum change

Adds one value: `insufficient_data`.

```prisma
enum CustomerState {
  active
  warm
  at_risk
  dormant
  lost
  insufficient_data   // NEW (session 2): merchant has <5 scorable customers
}
```

`@default(active)` unchanged. Migration: `ALTER TYPE "CustomerState" ADD VALUE 'insufficient_data';` (Postgres enum addition is non-breaking).

**Existing rows.** Every existing `Customer.state` row is `active` (default), unchanged. The first recompute writes the real state.

**Sentinel ordering.** Postgres preserves declaration order. `insufficient_data` lands at the end. No code path depends on enum ordering today; documented for forward safety.

---

## Trigger flow — drainer integration

### Order handlers (`apps/drainer/src/handlers/order.ts`)

Existing structure (session 1):
```ts
export async function handleOrderPlaced(...): Promise<void> {
  await withTenantScope(...);
  // inside scope: prisma.$transaction → orderRepo.upsertFromWebhook
}
```

Session 2 adds: AFTER the order upsert, INSIDE the same `$transaction` callback, call `customerScoreService.recompute({ merchantId, customerId, tx })` IF `customerId` is non-null.

Identical change to `handleOrderUpdated`.

### Customer handlers (`apps/drainer/src/handlers/customer.ts`)

Existing (session 1) → `customerRepo.upsertFromWebhook`. Session 2 adds: AFTER the upsert, call recompute with the customer's local id.

`handleCustomerDeleted` does NOT call recompute. Soft delete excludes the customer from future cohort reads. Existing CustomerScore row stays (forensic). No new state-changed event; the customer is gone.

### Recompute interface

```ts
// packages/db/src/services/customer-score.service.ts (new)
class CustomerScoreService {
  /**
   * Recompute RFM + state for ONE customer. Reads the merchant's scorable
   * cohort, computes quintiles inline, writes CustomerScore + (if state
   * changed) Customer.state + AuditLog + OutboxEvent.
   *
   * MUST be called inside an existing tenant scope + transaction. The `tx`
   * parameter is required — pre-read of the cohort and the write back
   * must share the same transaction (the TX invariant from session 1).
   *
   * Returns the outcome for logging/observability. Caller does not need
   * to act on the return value.
   */
  async recompute(args: {
    merchantId: string;
    customerId: string;
    tx: Prisma.TransactionClient;
  }): Promise<{
    rDays: number;
    fCount: number;
    mCents: bigint;
    rQuintile: number | null;
    fQuintile: number | null;
    mQuintile: number | null;
    churnRiskScore: number | null;
    previousState: CustomerState;
    newState: CustomerState;
    stateChanged: boolean;
    cohortSize: number;        // for the S-10 observability log
    durationMs: number;        // measured inside the service
  }>;
}
```

Placement: `packages/db/src/services/` (NEW directory — first service-layer file in `@winback/db`). Reasoning per session-1 rule #21 (data-flow direction):
- Service needs `WinbackPrisma`, repositories, and writes Customer + CustomerScore + AuditLog + OutboxEvent. All `@winback/db` concerns.
- Drainer (consumer) already depends on `@winback/db`. No circular import.
- Pure compute (quintile math) is testable without a DB; integration tests cover the wiring.

### Repository interface — CustomerScoreRepository (new)

Thin wrapper around `tx.customerScore.*` for the typed chokepoint. Used by the service.

```ts
// packages/db/src/repositories/customer-score.repository.ts (new)
class CustomerScoreRepository extends BaseRepository {
  /**
   * Returns live R/F/M aggregates for the merchant's scorable cohort.
   *
   * IMPORTANT — cohort source is the `Order` table, NOT existing
   * `CustomerScore` rows. Reading CustomerScore would be circular: each
   * customer's quintile depends on the cohort distribution, the cohort
   * distribution comes from the scores, and the scores come from
   * quintiles. Stale-fed-stale. Live aggregation against `Order` is the
   * only correct source.
   *
   * Implemented with `tx.$queryRaw` because Prisma's `groupBy` API can't
   * compose `COALESCE(shopifyProcessedAt, placedAt)` inside the grouping
   * projection cleanly. The raw SQL:
   *
   *   SELECT "customerId",
   *          FLOOR(EXTRACT(EPOCH FROM (now() - MAX(COALESCE("shopifyProcessedAt", "placedAt")))) / 86400)::int AS "rDays",
   *          COUNT(*)::int AS "fCount",
   *          SUM("totalAmountCents") AS "mCents"
   *   FROM "Order"
   *   WHERE "merchantId" = $1
   *     AND "financialStatus" = 'paid'
   *     AND "isTest" = false
   *     AND "placedAt" >= now() - INTERVAL '365 days'
   *     AND "customerId" IS NOT NULL
   *   GROUP BY "customerId"
   *
   * (NOTE: Order has no `deletedAt` column per schema convention —
   * orders are immutable; cancel/refund are status changes. Hence the
   * filter relies on `financialStatus = 'paid' AND isTest = false`,
   * not on a soft-delete predicate.)
   *
   * Returns at most one row per customer; only customers with ≥1 paid,
   * non-test, in-window order appear. Lurkers (no paid orders) are
   * absent — caller handles them via the S-6 fallback.
   *
   * The `tx` parameter is required — the cohort read and the per-customer
   * upsert must share the same transaction (TX invariant from session 1).
   */
  async readCohort(args: {
    merchantId: string;
    tx: Prisma.TransactionClient;
  }): Promise<Array<{ customerId: string; rDays: number; fCount: number; mCents: bigint }>>;

  async upsertScore(args: {
    merchantId: string;
    customerId: string;
    rDays: number;
    fCount: number;
    mCents: bigint;
    currency: string;
    rQuintile: number | null;
    fQuintile: number | null;
    mQuintile: number | null;
    churnRiskScore: number | null;
    computedAt: Date;
    tx: Prisma.TransactionClient;
  }): Promise<{ customerScoreId: string; isNewScore: boolean }>;
}
```

The service composes these + a direct `tx.customer.update` (for `state`) + `auditLogRepo.append` + `outboxRepo.create`. Both pre-read (cohort) and write back (upsert) use the same `tx` per the session-1 TX invariant.

---

## `customer.state_changed` outbox event payload

Locked per Q6. Schema in `apps/drainer/src/payload-schemas.ts` (drainer-side parsing) + Zod producer schema in `@winback/db` consumed by the service when writing the outbox event.

```ts
// @winback/db/src/events/customer-state-changed.ts (new — or co-located with service)
export const customerStateChangedPayloadSchema = z.object({
  merchantId: z.string(),
  customerId: z.string(),
  shopifyCustomerId: z.string(),                   // full GID per locked decision #4
  oldState: customerStateSchema,                   // includes 'insufficient_data'
  newState: customerStateSchema,
  computedAt: z.string().datetime(),               // ISO 8601 UTC
  rfmScore: z.object({
    rDays: z.number().int().nonnegative(),
    fCount: z.number().int().nonnegative(),
    mCents: z.string(),                            // BigInt serialized as string (rule #19)
    rQuintile: z.number().int().min(1).max(5).nullable(),
    fQuintile: z.number().int().min(1).max(5).nullable(),
    mQuintile: z.number().int().min(1).max(5).nullable(),
  }),
});

export type CustomerStateChangedPayload = z.infer<typeof customerStateChangedPayloadSchema>;
```

**BigInt serialization** (`mCents`) goes through `.toString()` at write time per Standing Rule #19. The drainer's payload-schemas re-parses the field as `z.string()` then the consumer (Epic G) converts back to BigInt at use.

**No `churnRiskScore` in payload.** Consumers compute it from the quintiles if they want; storing all of `rfmScore` + a derived field is redundant. (Reversible later if Epic G complains.)

**Producer call site.**
```ts
await outboxRepo.create({
  merchantId,
  type: OUTBOX_EVENTS.customer.state_changed,
  payload: {
    merchantId,
    customerId,
    shopifyCustomerId,
    oldState,
    newState,
    computedAt: new Date().toISOString(),
    rfmScore: { rDays, fCount, mCents: mCents.toString(), rQuintile, fQuintile, mQuintile },
  },
  tx,
});
```

**Consumer** stays `handleNoop` post-session-2. Epic G's winback-campaign engine becomes the real consumer when it ships. Session 2 only LANDS the producer.

---

## AUDIT_ACTIONS additions

New namespace `customer` with one action:

```ts
// packages/contracts/src/audit-actions.ts
export const AUDIT_ACTIONS = {
  gdpr: { ... },
  outbox: { ... },
  customer: {
    /** RFM scoring recompute moved the customer between state bands. */
    state_changed: 'customer.state_changed',
  },
} as const;
```

The `customer.state_changed` audit row writes in the SAME tx as the `Customer.state` update + the outbox event (Audit Write Policy from `ARCHITECTURE.md`). `actorType: 'system'`, `actorId: 'drainer'`, `subjectType: 'Customer'`, `subjectId: <customerId>`, `meta: { oldState, newState, rDays, fCount, mCents, rQuintile, fQuintile, mQuintile, currency }`.

**Exhaustive shape test** in `packages/contracts/tests/registries.test.ts` will fail on the missing namespace until the constant lands — registry-first pattern (rule #36) is satisfied because the call site (the service) ships in the same commit as the constant.

---

## Edge cases — enumerated for the audit

| Case | Behavior | Notes |
|---|---|---|
| Customer has no paid orders, merchant scorable cohort ≥5 | `state` from account-age R; quintiles null; `churnRiskScore` null | S-6 lurker handling |
| Customer has no paid orders, merchant scorable cohort <5 | `state = insufficient_data`; everything null | S-5 + S-6 |
| Order.customerId is null (guest checkout) | recompute is skipped | nothing to score |
| Customer soft-deleted via `customers/delete` | recompute skipped; existing CustomerScore stays | forensic; soft-delete excludes from future cohort reads |
| GDPR customer_redact | existing redact processor wipes Customer PII + soft-deletes; CustomerScore row's rDays/fCount/mCents stay (no PII; just aggregates) | revisit if legal flags; v1 keeps |
| Concurrent orders for same customer arrive at same second | drainer serializes per-merchant; each upsert+recompute is its own tx | same race as CP-2 `isFirstPurchase`; documented in CP-2 carry-forward |
| Customer with R = 31 days (boundary case) | `warm` (`30 < R ≤ 90`) | boundaries are strict-less-than on the low side |
| Customer with R = 30 days exactly | `active` (`R ≤ 30`) | boundary clarification |
| Merchant has exactly 5 scorable customers | quintiles computed (5 is the floor) | S-4 threshold |
| Merchant has 4 scorable + 1 lurker | scorable cohort = 4 → all customers `insufficient_data` | lurker doesn't count toward the 5-customer threshold |
| `shopifyProcessedAt` is null, `placedAt` available | falls back to `placedAt` for R compute | matches EPIC-E-FIELD-MAPPING row #6 fallback |
| Both `shopifyProcessedAt` AND `placedAt` are null | order is malformed; rejected at parse time per session-1 schema | not a runtime concern post-session-1 |
| Multi-currency merchant — single order in non-shop currency | `Order.totalAmountCents` is already shop currency (Shopify computes); sum is correct | S-3 + S-11 |
| Merchant changes shop currency | next recompute writes new currency on the row; old outbox events keep their snapshot | S-11 |

---

## What's NOT in session 2's scope (deferred)

- **Cached `QuintileBoundaries` table** — S-10 deferred. Schema + cron added when first merchant crosses ~10k scorable customers OR p95 recompute latency exceeds 200ms.
- **`pnpm cli:scoring:bulk-rescore --merchant $ID`** — operator command for backfill / one-shot recompute. S-9 deferred. Ships before the first merchant runs the customer backfill.
- **Per-merchant scoring overrides** — `MerchantSettings.scoringRWarmDays` etc. Q4 deferred. Revisit post-launch with cohort data.
- **`prospect` state for lurkers** — semantic-only addition. S-6 deferred; if Epic G wants the dedicated band, schema migration then.
- **Non-recency state dimensions** — `at_risk` triggered by F-drop, M-drop, etc. v1 is purely R-driven. Adding F/M to state assignment is its own design pass.
- **`customer.state_changed` consumer** — Epic G's winback campaign engine. Session 2 only lands the PRODUCER + stub consumer (`handleNoop` continues).
- **Backfill scoring** — S-9. Scoring service is NOT called from the backfill runner. Bulk operator pass handles post-backfill scoring.
- **Refund-adjusted M** — v1 uses original `totalAmountCents`. H1's CP-2 §Q2(d) refund math is at the rollup layer, not RFM. Documented in S-1.

---

## Repository / service surface — recap

| File | New / changed | Purpose |
|---|---|---|
| `packages/db/prisma/schema.prisma` | changed | Adds `CustomerScore` model + adds `insufficient_data` to `CustomerState` enum |
| `packages/db/prisma/migrations/<ts>_epic_e_session_2_customer_score/migration.sql` | new | Creates table + enum value addition |
| `packages/db/src/services/customer-score.service.ts` | new | Recompute service (cohort read → quintile math → write back) |
| `packages/db/src/repositories/customer-score.repository.ts` | new | Typed chokepoint over `tx.customerScore` |
| `packages/db/src/events/customer-state-changed.ts` | new | Zod producer schema |
| `packages/db/src/index.ts` | changed | Re-export the new service + repo + schema |
| `packages/contracts/src/audit-actions.ts` | changed | Adds `customer.state_changed` action |
| `apps/drainer/src/handlers/order.ts` | changed | Calls `customerScoreService.recompute` post-upsert |
| `apps/drainer/src/handlers/customer.ts` | changed | Calls `customerScoreService.recompute` post-upsert (created + updated paths) |
| `apps/drainer/src/payload-schemas.ts` | changed | Parses `customer.state_changed` outbox payload (still routed to `handleNoop`) |
| `apps/drainer/src/dispatch.ts` | unchanged | `customer.state_changed` already routes to `handleNoop`; comment updated to reflect "producer ships in session 2, consumer is Epic G" |
| `packages/db/tests/customer-score-service.test.ts` | new | Unit tests for quintile math (pure function, mocked Prisma) |
| `packages/db/tests/customer-score-repository.test.ts` | new | Unit tests for the repo (mocked Prisma) |
| `apps/drainer/tests/handlers/order.test.ts` | changed | Asserts recompute is invoked post-upsert |
| `apps/drainer/tests/handlers/customer.test.ts` | changed | Asserts recompute invoked post-upsert |
| `apps/drainer/tests/integration/drainer-tick.test.ts` | changed | End-to-end: paid order arrival → CustomerScore row written + Customer.state updated + outbox event written |
| `EPIC-E-SESSION-2-DESIGN.md` | new | This file |

Total estimated commits: 5 batches similar to session 1.

| Batch | Scope |
|---|---|
| 1 | Schema migration + enum value addition + this design doc |
| 2 | `CustomerScoreRepository` + Zod producer schema + audit-action constant + unit tests |
| 3 | `CustomerScoreService` (recompute + quintile math) + unit tests for the pure math |
| 4 | Drainer handler wiring (order + customer) + handler-level unit tests |
| 5 | Drainer integration tests against real Postgres + outbox-event end-to-end |

---

## CP-2 §Q1 carry-forward — what session 2 unlocks for H1

CP-2 §Q1 documented the same-tx pattern for `OrderRepository.upsertFromWebhook` → `qualifyingTransition` + `previousFinancialStatus`. Session 1 wired those return fields; session 2 demonstrates the consumer pattern (scoring service called inline inside the same tx).

This validates the H1 design: when Epic G eventually ships `Message` + `Campaign` + `WorkflowStepExecution`, H1 will land an AttributionEvent writer at the same call site, consuming `qualifyingTransition + previousFinancialStatus` the way session 2 consumes scoring. No new pattern; same chassis.

Concretely: post-session-2, the drainer's `handleOrderPlaced`/`handleOrderUpdated` inner tx callback looks like:
```
1. orderRepo.upsertFromWebhook  → returns {customerId, qualifyingTransition, previousFinancialStatus, ...}
2. customerScoreService.recompute (if customerId)           ← session 2
3. [future H1] attributionEventService.maybeWrite           ← Epic G + H1
```

Documented so H1's implementer in 2026-Q3 doesn't re-invent the wiring.

---

## Audit checklist — before approving this doc

- [ ] Every Q-lock from session-start is reflected in the doc + flagged as locked
- [ ] RFM compute is exhaustively specified (filter, window, fallback)
- [ ] Quintile algorithm is deterministic (tie-break documented)
- [ ] State boundaries are unambiguous (≤/< at every edge)
- [ ] `insufficient_data` enum addition is non-breaking (Postgres `ALTER TYPE ADD VALUE`)
- [ ] Lurker handling explicit (S-6)
- [ ] Backfill explicitly out of scope (S-9)
- [ ] Scale ceiling explicit + observability path defined (S-10)
- [ ] Trigger surface enumerated (which handlers call recompute, which don't)
- [ ] `customer.state_changed` payload contains everything Epic G/F will need (no FK reads at consume time)
- [ ] BigInt serialization at JSON boundary (Standing Rule #19) honored
- [ ] AuditLog row writes in same tx as the Customer.state update + outbox write (ARCHITECTURE.md Audit Write Policy)
- [ ] `AUDIT_ACTIONS.customer.state_changed` registry addition planned + tested
- [ ] Repository / service files placed per Standing Rule #21 (data-flow direction check)
- [ ] TX invariant (single `tx` for cohort read + write back) documented
- [ ] No code lands until this doc is approved

---

*This document is the source of truth for Epic E session 2 customer scoring + state machine + state-change producer. Update in the same commit as any handler, repository, service, or schema change that affects scoring or state assignment.*
