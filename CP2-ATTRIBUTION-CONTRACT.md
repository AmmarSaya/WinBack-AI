# CP-2 — Attribution Event Contract

Status: **DRAFT — pending review.** This document is the design output of
CP-2. No code lands until it's approved. Every ambiguity left here
becomes a schema migration after merchants are live, so precision wins
over length.

The schema changes implied by this document ship at H1 (per Phase 0's
Epic H reservation: `AttributionEvent`, `AttributionWindow`,
`MetricsDailyRollup`, `CustomerCurrencyTotal`). This document is the
contract H1 must satisfy.

**Sequencing dependency.** The `AttributionEvent` migration has hard
FK targets on `Message` and `Campaign` (introduced by Epic F's AI
generation pipeline and Epic G's campaign engine respectively), and
on `WorkflowStepExecution` (Epic G). **The H1 migration cannot run
until Epic G is complete.** Migration sequence:
`(C/D infra) → E (intelligence) → F (AI) → G (campaigns, introduces
Message + Campaign + WorkflowStepExecution) → H1 (AttributionEvent +
MetricsDailyRollup, FKs to G tables)`. The drainer's attribution
logic (this contract's logical implementation) ships at the latest
of `(D2, G complete)`, NOT at the latest of `(D2, H1)`. D2 wires the
attribution call site against the H1 table once it exists.

---

## Q1 — The triggering event

**Decision: Option C, with a qualifying-transition rule.** An
`AttributionEvent` row is inserted iff ALL of the following hold:

1. The triggering webhook is `orders/create` OR `orders/updated`.
2. The new `financial_status` is `paid`.
3. **Qualifying transition**: this is the first event where the order
   reaches `paid`. Specifically:
   - `orders/create` with `financial_status: paid` qualifies (immediate
     payment at checkout — the common case).
   - `orders/updated` qualifies ONLY when the previous `Order.financialStatus`
     in our DB was NOT `paid`. Detected by reading the existing `Order`
     row before applying the update.
4. There is at least one `Message` sent by this system to the order's
   customer within the attribution window before `Order.placedAt`. The
   model (Q4) decides which message gets credit.
5. No existing `AttributionEvent` row for `(merchantId, orderId)`. The
   `@@unique` constraint (Q3) is the backstop; the qualifying-transition
   check is the primary guard.

**What does NOT qualify (forward states).**
- `financial_status: pending`, `authorized`, `partially_paid`,
  `voided` — no attribution. Authorization is not revenue.
- Backfill — historical orders ingested via the C5 backfill runner do
  NOT generate `AttributionEvent` rows. Locked at Phase 0 ("Attribution
  only fires on real-time orders, not backfill"). The runner does not
  enqueue attribution work.

**Intermediate-state transitions, made explicit.**
- `pending → paid`: qualifies (first paid transition).
- `authorized → paid`: qualifies (auth-then-capture flow).
- `partially_paid → paid`: **qualifies**. The full paid state is what
  triggers attribution; the path through partial payment is irrelevant.
  This is the qualifying-transition rule doing its job — previous DB
  state was NOT `paid`, so the new `paid` is the qualifying edge.
- `paid → paid` (idempotent re-delivery): does not qualify; previous
  state was already `paid`.
- `paid → partially_refunded`, `paid → refunded`, `partially_refunded →
  refunded`: **these are refund transitions, not attribution triggers.**
  See Q2(d). They UPDATE an existing `AttributionEvent` row; they never
  create one.

**Where the qualifying-transition check executes.** Inside the D2 outbox
drainer's `order.placed`/`order.updated` handlers. The drainer reads the
existing `Order` row, decides if the transition qualifies, and — if so —
in the SAME transaction writes the `Order` update AND inserts the
`AttributionEvent` row. Atomicity with the business write is mandatory;
a half-applied attribution (Order updated, no row) is the failure mode
this entire design prevents.

**Refund flow** is intentionally NOT a separate trigger here. See Q2(d)
for how refunds compose with existing attribution rows.

---

## Q2 — The attribution window

### (a) What does the window measure from?

**Decision: `Message.sentAt`** (the timestamp we wrote when the send
pipeline emitted the message).

Reasons:
- Always known. Channel-independent. Doesn't depend on provider delivery
  webhooks (SMS providers' delivery reporting is unreliable; WhatsApp
  delivery is provider-dependent; email opens are unreliable due to
  prefetching).
- Stable across replay. If a message-event row gets re-ingested, `sentAt`
  is immutable; `deliveredAt` may be revised.

A future model variant (`engagement_weighted@v1` or similar) could key
off `firstClickedAt` for a stronger "the customer actually engaged"
signal. v1 does not.

### (b) Timezone for window math

**Decision: UTC.** Already locked in Phase 0 ("UTC time always.
Merchant-local windows use `Merchant.timezone`."). Window arithmetic is:

```
inWindow := (Order.placedAt − Message.sentAt) ≤ windowDays · 86400000 ms
```

Both timestamps are UTC instants; no timezone conversion at the
attribution step. Merchant-local conversion happens at the rollup
boundary (Q5), not here.

### (c) Multi-message-in-window: last-touch / first-touch / both?

**Decision: v1 = last-touch direct, with assisted message IDs preserved
on the same row.**

- **Primary credit** goes to the single most recent message within the
  direct attribution window (`MerchantSettings.attributionDirectWindowDays`,
  default 14) before `placedAt`. This is the v1 model `last_touch_direct@v1`.
- **Assists** are recorded as `assistedMessageIds: String[]` on the same
  row: every other message sent by this system to the same customer
  within the broader assisted window
  (`MerchantSettings.attributionAssistedWindowDays`, default 30) before
  `placedAt`, excluding the primary.
- **No fractional credit in v1.** All revenue is credited to the primary
  message. Multi-touch models (`linear@v1`, `time_decay@v1`,
  `position_based@v1`) become future model versions; they will read the
  same `AttributionEvent` rows and the same `assistedMessageIds` array
  to redistribute credit at rollup time.

Why preserve the assists now: the data is cheap to capture at write time
and impossible to reconstruct after the fact (messages get deleted,
campaigns get archived, retention policies kick in). Closing the door on
multi-touch by not storing it is the kind of decision that costs a
schema migration at H2.

### (d) Refunds within the window

**Decision: marker fields on the existing `AttributionEvent` row, NOT a
new compensating row and NOT deletion.**

Specifically:
- `refundedAt: DateTime?` — first time the order's financial_status
  transitioned to `refunded` or `partially_refunded`.
- `refundedAmountCents: BigInt?` — running total of refunded amount in
  `orderCurrency`. Updated on each subsequent refund event.
- `presentmentRefundedAmountCents: BigInt?` — same in presentment
  currency.

Rollup formula:
```
effectiveRevenueCents = orderAmountCents − (refundedAmountCents ?? 0)
```

Refund-trigger: `orders/updated` with `financial_status` in
`{refunded, partially_refunded}`. If an `AttributionEvent` exists for
the order, the row is updated (no new row). If no row exists (refund
on an order that never qualified for attribution), the refund is
ignored — there is nothing to reverse.

**Cumulative refund semantics.** A typical Shopify refund sequence is
`paid → partially_refunded → ... → partially_refunded → refunded`. The
refund-trigger fires on **every** transition that lands in either
state. `refundedAmountCents` is computed from the order's CURRENT
total-refunded-amount (Shopify reports this on the order payload as
`total_refunded`), NOT incrementally — each refund event overwrites
`refundedAmountCents` with the new running total from Shopify. This
makes the operation idempotent against duplicate webhook deliveries:
re-receiving the same refund event writes the same `refundedAmountCents`.
`refundedAt` is set on the FIRST refund transition and is never
updated by subsequent partial refunds (it's the "this order had ANY
refund activity, starting when" marker; the timeline lives in
`WebhookLog` for forensic reconstruction).

**Refund time horizon: unlimited.** Once attributed, refunds always
reverse on the `AttributionEvent` row itself, regardless of how long
after `placedAt` they arrive. The window in Q2 governs when attribution
can be CREATED; once a row exists, its lifecycle is governed by refund
events, not by the window.

**Rollup re-aggregation horizon: 180 days for v1.** The daily rollup
cron (Q5) re-aggregates the last 180 days each run, idempotently
overwriting those rows. Refunds landing within 180 days of `placedAt`
are reflected automatically at the next cron tick after the refund
event is processed.

Why 180 and not 90: Shopify's typical credit-card refund window is
~120 days; merchants also use store credit + manual refund flows
beyond that. 90 days would leave a merchant-visible accuracy gap on
dashboards labeled "recovered revenue this quarter" for the ~3% of
refunds landing in the 90–180 day tail. 180 days closes that gap at
the cost of ~2× cron-run compute, which is bounded and acceptable.

**Refunds landing >180 days after `placedAt`** still update the
`AttributionEvent` row (refund time horizon is unlimited), but they
do NOT auto-propagate to closed rollup rows. Operator runbook for
the long tail:

```sql
-- Re-aggregate MetricsDailyRollup for a specific merchant + date range.
-- Run via psql against the staging/prod replica. Operator opens a ticket
-- before running; the query is idempotent and safe under load.

WITH affected AS (
  SELECT DISTINCT
    a."merchantId",
    a."campaignId",
    DATE(a."placedAt" AT TIME ZONE m.timezone) AS day
  FROM "AttributionEvent" a
  JOIN "Merchant" m ON m.id = a."merchantId"
  WHERE a."merchantId" = $1                 -- merchant under remediation
    AND a."refundedAt" IS NOT NULL
    AND a."refundedAt" > a."placedAt" + INTERVAL '180 days'
)
-- Re-run the rollup aggregation for `affected` (...campaign/day pairs...).
-- Implementation: H1 ships this as a documented operator command
-- (`pnpm rollup:reaggregate --merchant $ID --since $DATE`).
```

H1 ships the operator command as a CLI subcommand; the dashboard
surfaces a "long-tail refund detected; rollup may be stale" indicator
on rows where `AttributionEvent.refundedAt > placedAt + 180 days` and
the rollup row's `updatedAt` is older than the refund. Merchants see
they can request remediation; operators have a one-command response.

---

## Q3 — The `AttributionEvent` payload shape

Schema-level draft. H1 produces the migration from this.

| Field | Type | Source | Notes |
|---|---|---|---|
| `id` | `String @id @default(cuid())` | generated | |
| `merchantId` | `String` (FK Merchant, **CASCADE**) | tenant scope | tenant discriminator; always injected by extension |
| `orderId` | `String` (FK Order, **CASCADE**) | trigger event | internal cuid; FK enforces tenant safety transitively |
| `customerId` | `String?` (FK Customer, **SetNull**) | Order.customerId at trigger time | nullable so GDPR redact severs the link without losing the revenue record |
| `messageId` | `String?` (FK Message, **SetNull**) | model output (primary) | nullable so message deletion doesn't lose the row; `messageSentAt` is denormalized for forensic survival |
| `campaignId` | `String?` (FK Campaign, **SetNull**) | Message.campaignId | nullable for the same forensic reason; denormalized `campaignSnapshot` (Q3 footnote) carries the readable name |
| `workflowStepExecutionId` | `String?` (FK WorkflowStepExecution, **SetNull**) | Message.workflowStepExecutionId | nullable; operator-triggered sends have no workflow |
| `assistedMessageIds` | `String[]` | model output (assists) | Postgres text array; messages within the assisted window other than the primary. Empty if none. |
| `orderAmountCents` | `BigInt` | Order.totalAmountCents | shop currency, never Float |
| `orderCurrency` | `String @db.Char(3)` | Order.currency | ISO 4217 |
| `presentmentAmountCents` | `BigInt?` | Order.presentmentTotalCents | nullable when shop and presentment match (Shopify omits) |
| `presentmentCurrency` | `String? @db.Char(3)` | Order.presentmentCurrency | nullable per above |
| `refundedAmountCents` | `BigInt?` | refund events (Q2d) | running total in `orderCurrency`; null until first refund |
| `presentmentRefundedAmountCents` | `BigInt?` | refund events (Q2d) | running total in `presentmentCurrency` |
| `refundedAt` | `DateTime?` | first refund event | UTC; null until first refund |
| `attributionWindowDays` | `Int` | MerchantSettings at trigger | snapshot of the direct-window value; freezes the policy for this row |
| `attributionModel` | `String` | model name+version | format `<name>@v<n>` (same as OUTBOX_EVENTS). v1 = `last_touch_direct@v1`. CHECK constraint enforces format (parallel to T4 on OutboxEvent.type) |
| `isFirstPurchase` | `Boolean?` | computed at trigger via `Order.count(merchantId, customerId, placedAt ≤ thisOrder.placedAt)` — see note below | denormalized for fast "first-time-buyer revenue" reporting; computed once, never updated. Nullable when `customerId` is null (guest checkout) |
| `placedAt` | `DateTime` | Order.placedAt | UTC; the event time the rollups bucket by |
| `messageSentAt` | `DateTime` | Message.sentAt at trigger | denormalized so message deletion doesn't lose the timing |
| `createdAt` | `DateTime @default(now())` | DB | when the row was written; usually very close to `placedAt` |
| `updatedAt` | `DateTime @updatedAt` | DB | bumped on refund updates |

**Indexes:**
- `@@unique([merchantId, orderId])` — primary idempotency guard. One row per order.
- `@@index([merchantId, placedAt])` — drives the daily rollup cron's scan.
- `@@index([merchantId, campaignId, placedAt])` — drives per-campaign reporting.
- `@@index([merchantId, customerId])` — per-customer attribution history (operator + intelligence).
- `@@index([merchantId, attributionModel])` — model-distribution dashboards / model-rollout monitoring.

**Cascade policy notes.** Merchant→AttributionEvent is CASCADE
(consistent with all tenant data; GDPR right-to-erasure removes
attribution along with the rest). Order→AttributionEvent is CASCADE
(without the order, the attribution row is orphaned and meaningless).
Customer/Message/Campaign/WorkflowStepExecution → AttributionEvent
are SetNull (preserve the revenue record even if the personal/source
link is severed).

**Denormalized fields locked deliberately** (against the normal
"avoid denormalization" reflex): `messageSentAt`, `attributionWindowDays`,
`isFirstPurchase`, the currency amounts, and the assisted message IDs
are all snapshots. They freeze the historical truth at attribution
time. Later changes to Message, MerchantSettings, or Customer
state must not retroactively rewrite past attributions; auditors and
operators need to see what was true when the row was created.

**`isFirstPurchase` computation note (issue raised in CP-2 review).**
The naive approach of reading `Customer.ordersCount == 1` is incorrect:
`ordersCount` is a Shopify-sourced cache that's updated by the
`customers/update` webhook on a different delivery channel than the
`orders/create` webhook. The two can arrive out of order — Shopify
does NOT guarantee per-shop event ordering. If `orders/create` lands
first, `Customer.ordersCount` may still read 0 at attribution time
even though this IS the first order.

The correct computation, performed inside the drainer's atomic tx for
the order:

```
isFirstPurchase = (count of Order rows where
                   merchantId = thisOrder.merchantId
                   AND customerId = thisOrder.customerId
                   AND placedAt <= thisOrder.placedAt
                   AND deletedAt IS NULL) == 1
```

The `customerId IS NOT NULL` guard is implicit (an order without a
customer cannot be a "first purchase" for any customer). If
`thisOrder.customerId` is null, `isFirstPurchase` is null (the Boolean
column is nullable for this case; not added as a separate type — H1
makes it `Boolean?`).

The count query is race-free because it runs in the same transaction
as the order write that triggered attribution; all other order writes
for this merchant + customer are serialized through the drainer.

**Schema additions in OTHER tables** (for completeness — H1 must add
these):
- `MerchantSettings.attributionModel: String @default('last_touch_direct@v1')`
  — per-merchant override of the active model. Today there's one
  model; this field becomes load-bearing when v2 ships.
- `AttributionWindow` table (Phase 0 reserved) — initially empty; reserved
  for future per-campaign or per-cohort window overrides. v1 uses the
  merchant-level setting only. Document it now so the field name doesn't
  collide later.

---

## Q4 — The attribution model interface

Plain English. Code lands at H1; this is the contract.

**Inputs to the model:**
1. `order: { orderId, placedAt, totalCents, currency, customerId | null }`
   — the order being attributed. Already known to be in a qualifying
   transition (Q1).
2. `merchantSettings: { attributionDirectWindowDays,
   attributionAssistedWindowDays }` — snapshot at trigger time. The
   model uses these values, not the live settings (which may have
   changed since).
3. `candidateMessages: Array<{ messageId, campaignId, sentAt,
   workflowStepExecutionId | null }>` — every message this system sent
   to `order.customerId` between `placedAt - max(direct, assisted)Window`
   and `placedAt`, in `sentAt-ascending` order. Already filtered by:
   - same merchant
   - same customer
   - message status = `sent` (excludes failed/queued/cancelled)
   - sent BEFORE `placedAt` (strict `<`, not `≤` — same-millisecond ties
     are conservatively dropped to avoid attributing a same-tx send)
4. `model: { name, version }` — the model identifier. Picked from
   `MerchantSettings.attributionModel`; defaults to `last_touch_direct@v1`.

**Outputs from the model:**
- Either: `{ primary: CandidateMessage, assists: CandidateMessage[],
  modelIdentifier: string }` — the row to write.
- Or: `null` — no qualifying message; no row is written. (Possible cases:
  every candidate is outside the direct window, or `candidateMessages`
  was empty.)

The model identifier output exactly matches the input model — the model
is responsible for stamping its own name+version on its output. This
is how H1 verifies "the right model ran." A model that disagrees with
its name has a bug; the validation is the test suite (Q3-shape regression
test in `packages/contracts/tests/registries.test.ts` will not cover
this — H1 adds a model-output-shape test).

**v1 model: `last_touch_direct@v1`.**

Algorithm (in prose):
1. Filter `candidateMessages` to those where
   `(placedAt - sentAt) ≤ attributionDirectWindowDays · 86400000 ms`
   and `sentAt < placedAt`.
2. If filtered list is empty → return `null`.
3. Primary = the message with the maximum `sentAt` in the filtered list.
   (Stable tie-break: if two messages share `sentAt` to the millisecond,
   pick the higher `messageId` lexicographically. The property the
   tie-break relies on is **determinism for any given pair** — same
   inputs always sort the same way — which is sufficient for idempotency
   under replay. Time-correlation of the cuid is NOT a property this
   logic depends on. Current schema uses `@default(cuid())` which is
   cuid v1 and happens to be timestamp-prefixed, but the same tie-break
   is correct under cuid v2 or any future ID scheme that produces
   stable lexicographic ordering for distinct values.)
4. Assists = every message in the ORIGINAL `candidateMessages`
   (assisted-window-filtered, not direct-window-filtered) other than
   the primary, where
   `(placedAt - sentAt) ≤ attributionAssistedWindowDays · 86400000 ms`.
5. Return `{ primary, assists, modelIdentifier: 'last_touch_direct@v1' }`.

The model is a pure function. It does not read the database, does not
write the database, does not consult external systems. The drainer
fetches `candidateMessages` once and passes them in.

**Storage of model version on the row.** `AttributionEvent.attributionModel:
String`, value `last_touch_direct@v1`. CHECK constraint enforces the
canonical `<name>@v<n>` format. The string is queryable; we can answer
"what fraction of last month's attribution used v1?" without scanning
every row's logic.

**Future models** (named here so the design is forward-compatible — do
not implement):
- `last_touch_assisted@v1`: primary = last in assisted window. Differs
  from `last_touch_direct@v1` only when no direct-window match exists.
- `linear@v1`: split credit equally across all messages in the assisted
  window. Requires a second table (`AttributionEventCredit`) keyed
  `(attributionEventId, messageId, fractionalCredit)`. Out of v1 scope.
- `time_decay@v1`: similar to `linear@v1` with exponentially decaying
  weight by `(placedAt - sentAt)`.

---

## Q5 — The rollup strategy

### (a) Granularity

**Decision: daily per `(merchantId, campaignId)` in
`MetricsDailyRollup`.** Daily per-merchant totals are computed at
query time by summing the rollup rows for that merchant — no separate
table.

`MetricsDailyRollup` (Phase 0 reserved) primary key:
`@@unique([merchantId, campaignId, date])`. `date` is `Date` (no time
component) in `Merchant.timezone` — see (b) and (c).

Per-campaign granularity is the most useful operator view ("which
campaign generated revenue today?") and the natural input for
campaign-ROI reporting. Per-message granularity is out of scope for
the rollup table; operators wanting message-level data query
`AttributionEvent` directly with `messageId` indexes.

### (b) Currency

**Decision for v1: shop currency only.** Each rollup row carries:
- `shopCurrency: String @db.Char(3)` — denormalized from Merchant
- `revenueShopCurrencyCents: BigInt`
- `refundedShopCurrencyCents: BigInt`
- `attributedOrderCount: Int`
- `refundedOrderCount: Int`
- `firstPurchaseOrderCount: Int` — for the "new-customer revenue" view

**Deferred to a follow-up:** a `presentmentBreakdown: Json` column on
`MetricsDailyRollup` keyed by currency-code → cents totals, for
multi-currency stores. Phase 0 promised this; no merchant has asked
yet; ship when one does. The `AttributionEvent` row carries
`presentmentAmountCents` and `presentmentCurrency` so the data is
preserved for retroactive aggregation when the feature ships.

### (c) Trigger — cron, not event-driven

**Decision: cron only for v1.** No incremental event-driven rollup
writes.

**Cron schedule: hourly, single UTC-clock job.** Concrete behavior:

- The scheduler (D3) fires the rollup worker once per hour at minute 0
  UTC. Single timer, not 40+ per-timezone timers.
- Each run selects the merchants whose local midnight fell in the
  preceding hour:
  ```
  SELECT id, timezone FROM "Merchant"
  WHERE timezone IS NOT NULL
    AND uninstalledAt IS NULL
    AND (now() AT TIME ZONE timezone)::time < '01:00:00'
    AND (now() AT TIME ZONE timezone)::time >= '00:00:00'
  ```
  Each merchant is processed at most once per cron tick, and exactly
  once per day across all ticks (their local midnight falls in exactly
  one UTC hour).
- For each selected merchant, scan `AttributionEvent` rows with
  `placedAt` in `[merchant_local_today - 180 days, merchant_local_today]`
  (UTC instants; comparison done after converting the merchant-local
  day boundaries to UTC) and idempotently upsert the corresponding
  `(merchantId, campaignId, date)` rollup rows. Each merchant gets one
  `withSystemScope('rollup.daily')` + per-day chunked `uow.run` pass.

Why hourly instead of one daily UTC-midnight burst: spreads the load
across the day rather than spiking 10k merchants of work into a single
hour. Merchants with `timezone` matching a given UTC offset are
processed together; the load is bounded by the count of merchants in
that timezone hour, not the total merchant count.

Why not per-merchant scheduled events: the scheduler (BullMQ-backed
in D1+) would maintain 10k+ persistent recurring jobs. The hourly
sweep with a single timezone-filter query is operationally simpler and
testable as one cron entry.

`Merchant.timezone IS NULL` (the merchant hasn't been enriched yet)
falls back to UTC by being matched at UTC midnight (the WHERE clause
on `timezone IS NOT NULL` excludes them; a separate fallback case in
the worker handles `NULL → UTC` aggregation at the 00:00–01:00 UTC
tick). Documented; ship the timezone-NULL fallback as a small special
case in D3.

- 180-day re-aggregation window covers refunds landing on older orders.
  Refunds beyond 180 days: see Q2(d) for the operator runbook.

**Today-so-far queries** (operator dashboard) hit `AttributionEvent`
directly. The drainer-indexed `(merchantId, placedAt)` index is the
hot path. Closed-day rollups are read from `MetricsDailyRollup`.

Why not event-driven incremental rollups:
- Race condition on read-modify-write of the rollup row at high traffic.
- Doubles the write path (every attribution becomes one row write + one
  rollup update) for a feature operators will tolerate ~1 day of lag on.
- Adds a failure mode where the rollup drifts from the underlying events
  and has to be re-synced.

If merchants demand sub-hour rollup latency, switch the cron to hourly
(no schema change). If real-time is genuinely needed, build incremental
updates as a separate effort — don't bake them in now.

### Rollup integrity test

H1 ships a fixture-based test: a hand-computed `AttributionEvent` set
→ run the rollup cron → assert the resulting `MetricsDailyRollup`
matches the hand-computed totals. **±2% tolerance is CP-6**, NOT v1
correctness; v1 must be exact against the fixture. CP-6's ±2% is for
real-store reconciliation, which has noise from refund timing and
provider-side data.

---

## Q6 — The error envelope

**Confirmed:** the proposed shape matches `toHttp` from `@winback/errors`
exactly. Use it.

```json
{
  "error": {
    "code": "attribution.window_expired",
    "message": "Internal server error",
    "requestId": "req_abc123",
    "fields": { /* optional, validation cases only */ }
  }
}
```

`fields` is the same optional field `toHttp` already populates from
`AppError.context.fields` for `ValidationError` instances.
`message` is generic for non-exposed errors (the default), or the
specific error message for `ValidationError` / `NotFoundError` etc.
`requestId` is populated when the caller supplies it via
`ToHttpOptions.requestId`.

### Attribution-domain error code namespace

Most "attribution did not produce a row" outcomes are NOT errors —
they are normal control flow. Specifically:

| Outcome | Disposition |
|---|---|
| No candidate messages in window | No row. Silent. Log at `debug`. NOT an error. |
| Customer redacted between order placement and attribution | Row written with `customerId: null`. NOT an error. |
| Duplicate attribution attempt (same orderId) | `@@unique` violation caught silently. Drainer logs `info`. NOT an error. |
| Order placedAt > messageSentAt by less than 1ms (same-tx send) | Excluded by `<` not `≤` filter. NOT an error. |

The error envelope is reserved for genuine failures, which map to
existing `AppError` subclasses:

| Error code | AppError subclass | When |
|---|---|---|
| `attribution.tenant_mismatch` | `TenantScopeError` (which inherits from AppError via the existing wiring) | Drainer scope assertion failed. Should never happen; indicates a code bug. |
| `attribution.invalid_payload` | `ValidationError` (400) | Webhook payload missing required fields (orderId, totalCents, currency). Caller (Shopify) cannot fix; log + ack. |
| `attribution.processor_failed` | `FatalError` (500) | Unhandled exception. Logged with full context; drainer dead-letters. |
| `attribution.model_unknown` | `ConfigurationError` extending `AppError` (500) | `MerchantSettings.attributionModel` references a model the code doesn't implement. Operator alert; do not silently fall back to v1 (that's data loss). |
| `attribution.timeout` | `TimeoutError` (504) | DB transaction timed out. Drainer retries via the standard retry mechanism. |

`attribution.window_expired` is NOT an error code in this taxonomy —
the "expired" case is "no candidate messages in window," which is the
silent no-op case above. The original example in the framework was
illustrative of the envelope SHAPE, not a real code.

---

## Open questions deferred to H1

These exist on the H1 implementer's table, not the contract:

1. **The drainer's transaction shape.** This contract requires the
   `Order` update and the `AttributionEvent` insert to be atomic in one
   `UoW.run` callback. H1 must wire this without breaking the drainer's
   batch-processing model. The compromise (1 order = 1 tx vs. N orders =
   1 tx) is a D2/H1 detail.
2. **The `Message` / `Campaign` / `WorkflowStepExecution` models.**
   None exist yet. They land at F/G epics. H1 cannot ship until those
   exist; the AttributionEvent FK constraints depend on them. The
   sequencing dependency is stated in the document header — H1 begins
   only after Epic G is complete. This is the largest single open
   item; CP-2 unlocks D2's design, but D2's attribution wiring is
   gated on Epic G's completion. The drainer can land WITHOUT
   attribution support and have it added at H1.
3. **Per-merchant model overrides.** `MerchantSettings.attributionModel`
   is named in this contract but not added to the schema until H1. The
   default `last_touch_direct@v1` is what every existing row gets at
   migration time.
4. **Backfilling AttributionEvent rows for historical orders that
   happen to match a recent message.** Out of scope per Q1's
   "backfill never fires attribution" rule. Operators wanting this can
   run a one-off SQL script post-launch; we don't ship it as a feature.

---

## Approval gate

CP-2 is approved when the reviewer confirms each of the six Q-answers
above. The schema migration ships at H1 against this document; the
drainer integration with attribution ships at D2 + H1.

Until approved, no schema columns are added, no model code is written,
no migration files exist.

**Reviewer checklist:**
- [ ] Q1 trigger conditions are exhaustive and unambiguous; the explicit
      intermediate-state table (`partially_paid → paid` qualifies;
      `pending/authorized → paid` qualify; idempotent `paid → paid`
      doesn't; refund transitions are not triggers) is correct
- [ ] Q2 window semantics (sent-time, UTC, last-touch + assists,
      refund-marker fields with cumulative running-total semantics)
      are correct
- [ ] Q3 payload shape includes every required field, no orphaned
      ambiguities, no missing FKs, indexes cover the named query patterns;
      `isFirstPurchase` is nullable Boolean and computed via Order.count
      (NOT via the Shopify-cached Customer.ordersCount, which races with
      out-of-order webhook delivery)
- [ ] Q4 model interface is implementable as a pure function and the
      versioning scheme survives model swaps; the tie-break rule relies
      on lexicographic determinism (NOT cuid time-correlation)
- [ ] Q5 rollup granularity + currency policy + cron-only-for-v1
      decision is acceptable; hourly UTC-clock cron schedule with
      timezone-filter selection is acceptable; the 180-day re-aggregation
      window + documented operator runbook is acceptable
- [ ] Q6 error envelope matches `toHttp` and the "most failures are
      silent" disposition is correct
- [ ] Open-questions-deferred-to-H1 list captures the right deferrals,
      including the explicit Epic G sequencing dependency
