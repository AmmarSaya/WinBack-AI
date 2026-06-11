# EPIC-G-DESIGN.md — Campaigns + Email Dispatch (v1)

**Status:** ACTIVE — founder-approved 2026-06-10 (design + all judgment calls + the `dailySendCap` pin). Batch 8.1 ships this doc + the schema migration + the consent ingestion together.
**Batch:** Section 8 / batch 8.1 (design doc + schema). This doc is the 8.1 deliverable; it is reviewed BEFORE any schema or code is built.
**Scope:** The v1 SEND pipeline — dispatching the draft `Message` rows Epic F already generates, over **email only**, as **single-touch campaigns**, with consent + suppression + send-time + quota gating, delivery/engagement tracking, and Shopify Marketing Activities reporting.
**Companion docs:** `POST-EPIC-F-CONSCIOUS-DECISION.md` §8 (scope locks V1–V10), `ARCHITECTURE.md` (locks), `EPIC-F-DESIGN.md` (Q4 generation/dispatch seam; the doc pattern this follows), `CP2-ATTRIBUTION-CONTRACT.md` (Epic G's `MessageEvent` rows are H1's input), `SHOPIFY-SCOPES-AUDIT.md` (`write_marketing_events` / `read_marketing_events`), `handoff.md` (the order-reconciliation flaw decision).
**Schema reference:** `packages/db/prisma/schema.prisma` at `main` SHA `c517e43`.

This document is a permanent contract for Epic G v1. Any change to v1 channel, dispatch model, consent posture, or the deferred-items set MUST update this file in the same commit.

---

## Locked decisions (read first)

| Q | Lock | Rationale |
|---|---|---|
| **G-Q1 — Channel** | **Email-FIRST. SMS deferred to its own later batch.** | SMS ≈ doubles compliance + integration scope (TCPA express opt-in, STOP handling, Twilio 10DLC carrier reg) and turns a deliverability risk into a per-message legal one. The winback value (AI message + customer-scoped discount) is fully realized over email; the discount code is channel-agnostic. §8 wants both eventually — we SEQUENCE, not drop. |
| **G-Q2 — Workflow** | **DEFERRED.** v1 = **single-touch Campaign** dispatching the existing per-transition drafts. | `EPIC-F-DESIGN` Q4 locks "Epic G's dispatch worker reads existing draft `Message` rows; G does NOT trigger generation." Epic F generates ONE draft per (customer, state-transition). A 5-step generated workflow would violate Q4. Single-touch dispatch respects Q4 and ships the core value. The multi-touch Workflow (drip-resend vs Q4 amendment) is a later batch. |
| **G-Q3 — Segment engine** | **DEFERRED.** v1 audience = trigger-state band + consent + gates, off existing data. | The trigger state is on `AiGeneration` (and on the draft via the 1:1). The rich RFM/tag/custom-field Segment engine (§8.5) is additive — it does not restructure v1 dispatch. |
| **G-Q4 — Send infrastructure** | **ESP sends; Marketing Activities reports.** SendGrid for v1. | The Shopify Marketing Activities API does NOT send email — it registers a marketing activity + reports outcomes to the merchant's admin dashboard (satisfies §8's "native-in-Admin feel"). The actual send is an ESP (SendGrid). SendGrid event webhooks feed `MessageEvent`. |
| **G-Q5 — Dispatch model** | **Queued BullMQ** (consistent with the system). **Scheduler-tick** re-evaluates time-sensitive gates. | Outbox → BullMQ worker is the house pattern. Time-sensitive gates (quiet-hours, freshness, quota) are re-evaluated at each tick rather than baked into a delayed job, so a job that waits for the send window doesn't fire on stale conditions. |
| **G-Q6 — Drift-flaw guard** | **Send-time freshness gate** (suppress if the customer placed a qualifying order within N days). Reconciliation sweep DEFERRED. | The A1-parked missed-webhook flaw (dropped `orders/create` → drifted scoring → winback fired at an actively-buying customer) manifests THROUGH dispatch. A send-time freshness check neutralizes the *consequence* at the boundary; A3 proved the local recent-order read is cheap + tenant-safe. A standalone order-reconciliation sweep (fixes the *cause*) is deferred future hardening. |
| **G-Q7 — Consent** | **Channel-specific `Customer.emailMarketingConsentState`** (NOT the coarse `acceptsMarketing` bool), ingested from Shopify. **`Suppression` table + CAN-SPAM unsubscribe.** Mandatory v1. | Even email-only needs a working unsubscribe + suppression (CAN-SPAM ≤10-day honor; GDPR opt-out). A single boolean can't carry channel-specific state. SMS-specific consent + STOP deferred with SMS (G-Q1). |
| **G-Q8 — Frequency floor** | **Reuse the EXISTING `MerchantSettings.defaultCooldownHours` (default 168 = 7d) + `maxDailySendsPerCustomer` (default 1).** NO new field. | A customer can transition states repeatedly (active↔at_risk, decay progression) and scoring drift can induce repeat drafts; without a floor a customer could get multiple winbacks in a short window (spammy + list-hygiene/compliance risk). These two fields ALREADY exist (`schema.prisma:299-300`) and ARE the per-customer floor — the gate reads them; we do NOT add a redundant column (the 7-day cooldown is better-reasoned than an arbitrary new window). The full per-campaign frequency engine is deferred with Workflow. |
| **G-Q9 — Quota = SAFETY caps (daily + monthly) + atomicity** | TWO per-merchant SAFETY ceilings (NOT budgets): NEW `dailySendCap` (daily runaway-protection, @default 2000) + EXISTING `monthlySendsCap` (true-abuse ceiling, default RAISED to 50000). `MessageQuotaBucket` (daily, AiSpendBucket pattern) serves BOTH — day's count vs `dailySendCap`, month's summed buckets vs `monthlySendsCap`. `SELECT … FOR UPDATE` increment + authoritative check of BOTH in the SAME mark-sent tx (A4 pattern), NOT check-then-send. | Circuit-breakers, NOT plan budgets — in the success-based model an overly-tight cap suppresses the founder's own commission, so caps fire only on malfunction / true abuse. Daily catches a bug firing thousands; monthly catches a true list-blast. Plan-tier send limits are a Billing-workstream decision (G-Q11), not 8.1. |
| **G-Q10 — Gate order** | **All TERMINAL gates before all TRANSIENT gates.** | Don't burn re-queue cycles (quiet-hours/quota) on a draft a terminal gate (suppression/consent/freshness/frequency) will kill anyway. |
| **G-Q11 — Billing + pricing** | **Launch-gate, not build-gate** (`POINTS-TO-CONSIDER` #20). Pricing = success-based: $99/$199 base + revenue-share on winback conversions. | Billing wired before campaigns SHIP (charge), not before built. **Plan-tier-based send limits are a Billing-workstream decision pending the locked tiers — NOT 8.1.** 8.1's caps are tier-agnostic safety ceilings (G-Q9); the per-merchant cap fields carry tier-specific values once tiers lock, no schema retrofit. Lock tiers before go-live so the billing data model isn't retrofit. No send-path code dependency. |
| **G-Q12 — Discount** | Consumed from `AiGeneration` (A4 §4.2). **Epic G never creates discount codes.** | The code + `shopifyDiscountId` are already on the draft's `AiGeneration`; dispatch ships the already-substituted `Message.generatedText`. |

---

## Scope

### In scope (v1)
Email-only, single-touch **campaign dispatch** of Epic F's draft `Message` rows: a merchant enables a Campaign for a trigger-state band; a queued dispatch worker picks up matching drafts, runs the gate chain, sends via SendGrid, records the lifecycle + events, and reports the activity to Shopify Marketing Activities. Consent (channel-specific) + suppression + CAN-SPAM unsubscribe + send-time window + per-merchant quota + a frequency floor.

### Explicitly DEFERRED (with rationale) — see the Deferred-items register
- **SMS channel** (G-Q1) — own batch: `smsMarketingConsentState`, STOP handling, Twilio 10DLC.
- **Workflow engine** (G-Q2) — multi-touch sequences collide with EPIC-F Q4; resolve later.
- **Segment engine** (G-Q3) — RFM/tag/custom-field audiences; v1 targets trigger-band + consent.
- **Order-reconciliation sweep** (G-Q6) — the freshness gate covers the consequence in v1.
- **Per-campaign frequency engine** (G-Q8) — v1 ships only the per-customer floor.

---

## v1 data model

> Convention reminders (ARCHITECTURE): every business table carries `merchantId` and is added to `TENANT_SCOPED_MODELS`; money is BigInt cents; UTC; cuid PKs / full Shopify GIDs; cascade-policy header updated in the same migration. Shapes below are the design contract; exact Prisma syntax lands in the 8.1 migration after this doc is approved.

### Enums

```
enum MessageChannel { email }            // sms, whatsapp reserved (G-Q1)

// ALTER existing MessageStatus ADD VALUE (Postgres non-breaking, like Epic E's insufficient_data):
//   draft (existing) → sent, suppressed, failed, bounced, opened, clicked
// Message.status holds the FURTHEST-PROGRESSED lifecycle/engagement state;
// MessageEvent is the authoritative append-only event stream (see note ‡).

enum EmailMarketingConsentState {        // mirrors Shopify CustomerEmailMarketingState (v1 subset)
  subscribed
  not_subscribed
  pending
  unsubscribed
}

enum CampaignStatus { draft active paused archived }

enum CampaignTargetStatus { pending sent suppressed deferred failed }

enum SuppressionReason { unsubscribe bounce complaint manual }

enum MessageEventType { sent delivered opened clicked bounced complained unsubscribed failed }
```

‡ **Status-vs-events (APPROVED — high-water-mark):** a message can be sent → opened → clicked. `Message.status` is a denormalized read-optimization tracking the highest-water-mark; the authoritative append-only history lives in `MessageEvent`. **Monotonic-ordering REQUIREMENT (the dispatch / webhook-ingest code enforces this):** status advances only FORWARD along `sent < delivered < opened < clicked`; a late-arriving earlier-stage webhook (e.g. `delivered` arriving after `clicked`) MUST NOT regress the status. `bounced` / `complained` / `failed` are terminal-negative and override the engagement progression. The full event sequence is always recoverable from `MessageEvent` regardless of the status high-water-mark.

### New tables (5)

```
Campaign            // merchant's dispatch rule (the opt-in to SEND for a band)
  id, merchantId(FK Cascade), name, status(CampaignStatus @default(draft)),
  channel(MessageChannel @default(email)),
  triggerStates String[]            // which winback bands it dispatches: at_risk|dormant|lost
  marketingActivityId String?       // Shopify Marketing Activities GID (reporting link, G-Q4)
  createdAt, updatedAt
  @@index([merchantId, status])

CampaignTarget      // the dispatch unit: one campaign's attempt to send one Message
  id, merchantId(FK Cascade), campaignId(FK Cascade), messageId(FK Cascade @unique),
  customerId(FK Cascade),
  status(CampaignTargetStatus @default(pending)),
  suppressedByGate String?          // which terminal gate killed it (suppression|consent|freshness|frequency) — forensic
  queuedAt, sentAt DateTime?
  createdAt, updatedAt
  @@index([merchantId, status]); @@index([campaignId, status])

Suppression         // per-(merchant, customer, channel) hard stop — first send-gate
  id, merchantId(FK Cascade), customerId(FK Cascade), channel(MessageChannel),
  reason(SuppressionReason), createdAt
  @@unique([merchantId, customerId, channel])   // one active suppression per channel
  @@index([merchantId, channel])

MessageEvent        // append-only delivery+engagement log; H1's attribution input
  id, merchantId(FK Cascade), messageId(FK Cascade), type(MessageEventType),
  occurredAt DateTime, providerEventId String?,  // SendGrid event id for idempotent webhook ingest
  metadata Json?    // e.g. clicked URL, bounce classification
  @@unique([merchantId, providerEventId])        // webhook idempotency (skip duplicate deliveries)
  @@index([merchantId, messageId]); @@index([merchantId, type, occurredAt])  // H1 hot path

MessageQuotaBucket  // per-merchant DAILY send count; caps = MerchantSettings.dailySendCap (day) + monthlySendsCap (month-sum) (G-Q9); A4 AiSpendBucket pattern
  id, merchantId(FK Cascade), date DateTime,     // UTC day bucket
  sentCount Int @default(0)
  @@unique([merchantId, date])
```

**Build-note (Campaign CRUD, batch 8.5):** `Campaign.triggerStates` entries MUST be validated against the `CustomerState` enum at write time — Prisma cannot constrain array CONTENTS, so the app layer rejects a campaign targeting a non-existent state (app-level validation is the pattern; same as `aiTone`'s write-time Zod validation).

### ALTER existing `Message` (per §8, minus the deferred Workflow FK)

```
+ campaignId  String?   campaign  Campaign? @relation(... onDelete SetNull)
+ channel     MessageChannel?     // null on legacy drafts; set at dispatch
+ sentAt      DateTime?
+ provider    String?             // 'sendgrid'
// DEFERRED (Workflow): workflowStepExecutionId  — NOT added in v1
```

### Consent field + **ingestion path** (G-Q7 — the column is useless without this)

```
ALTER Customer:
+ emailMarketingConsentState EmailMarketingConsentState @default(not_subscribed)
  @@index([merchantId, emailMarketingConsentState])  // audience-build hot path
```

**Ingestion (MUST ship in 8.1, not just the column):**
- **Customer webhooks** (`customers/create`, `customers/update`): `CustomerRepository.upsertFromWebhook` maps Shopify's `emailMarketingConsent.marketingState` → `EmailMarketingConsentState`. Extend the customer webhook body schema (`packages/db/src/webhook-bodies.ts`) + the upsert's writable fields.
- **Customer backfill** (install-time import, `packages/shopify/src/backfill/customer-backfill.ts`): the GraphQL customer query adds `emailMarketingConsent { marketingState }`; the adapter maps it through the same path (reusing `upsertFromWebhook`, like order-backfill does).
- **Default `not_subscribed`** for un-ingested rows — safe-by-default (no consent assumed; the consent gate fails closed).
- `acceptsMarketing` (existing coarse bool) is RETAINED (Shopify-sourced) but is NOT the gating field — `emailMarketingConsentState` is.

### ALTER existing `MerchantSettings` — caps are SAFETY circuit-breakers, NOT budgets

```
+ dailySendCap    Int @default(2000)    // NEW: per-merchant DAILY runaway-protection ceiling
~ monthlySendsCap Int @default(50000)   // EXISTING field — default RAISED 1000 → 50000 (safety ceiling, not budget)
```

**v1 caps are SAFETY circuit-breakers, DECOUPLED from pricing — NOT plan budgets.** In the success-based model ($99/$199 base + revenue-share on winback conversions), an overly-tight cap would suppress the FOUNDER'S own commission (he earns on conversions), so caps must NOT throttle legitimate volume — they fire only on malfunction / true abuse:
- **`dailySendCap @default(2000)`** (NEW): pure runaway-protection. Above any real big-merchant daily winback volume; below a bug firing thousands. Fires on malfunction, not on real volume.
- **`monthlySendsCap`** (EXISTING): default RAISED **1000 → 50000**. The old 1000 is far too low for the target merchant ($5M–$50M, thousands of monthly lapse-events) and would suppress the founder's commission; 50000 is a true-abuse ceiling (e.g. a $99-plan merchant blasting a 500k list), not a budget. Migration = `ALTER COLUMN "monthlySendsCap" SET DEFAULT 50000` (metadata-only) **+ a targeted backfill** `UPDATE … SET monthlySendsCap = 50000 WHERE monthlySendsCap = 1000` (the dev-store rows still on the OLD default — 1000 was never a deliberate per-merchant choice). ⚑ *Confirm the backfill, or default-only (existing dev-store rows stay 1000).*

**Plan-tier send limits ($99 vs $199 → different caps) are a Billing-workstream decision (G-Q11), NOT 8.1** — they land when the $99/$199/revenue-share tiers lock. The per-merchant cap FIELDS can carry tier-specific values then, **no schema retrofit needed**. 8.1's caps are safety-only, tier-agnostic. Erring HIGH on a safety ceiling is the conservative choice in a success-based model: a too-low cap costs the founder revenue, while a generous ceiling still catches true runaways.

### TENANT_SCOPED_MODELS + cascade policy
Add `Campaign, CampaignTarget, Suppression, MessageEvent, MessageQuotaBucket` to `TENANT_SCOPED_MODELS`; all FK to `Merchant` (and to `Customer`/`Message`) CASCADE so GDPR shop/customer redact severs them. Update the schema cascade-policy header in the same migration.

---

## Dispatch architecture

A new **dispatch worker** (BullMQ, in `apps/drainer` alongside the AI worker, or a dedicated queue — confirm in the dispatch batch) consumes a `campaign.dispatch` job per draft `Message` selected for an active Campaign. A **scheduler tick** (`apps/scheduler`, on the existing `cron.sweep`-style cadence) enqueues eligible drafts (active Campaign matching the draft's trigger band, `status=draft`, no terminal-gate hit) and is the re-evaluation point for transient gates (G-Q5).

Mirrors the AI worker's shape: gate reads OUTSIDE any tx → external send OUTSIDE any tx → completion tx (atomic state write).

---

## The dispatch gate chain (G-Q10 — terminal first, then transient)

Per draft `Message`, in order. Reads run outside any tx.

| # | Gate | Type | Outcome | Reads from |
|---|---|---|---|---|
| 1 | **Suppression** | terminal | `Message.status=suppressed`, `CampaignTarget.suppressedByGate='suppression'` | `Suppression` (merchant, customer, email channel) |
| 2 | **Consent** | terminal | suppressed (`'consent'`) | `Customer.emailMarketingConsentState == subscribed` |
| 3 | **Freshness / drift-guard** | terminal | suppressed (`'freshness'`) | local `Order` (A3 qualifying defn) — a qualifying order with recency (`COALESCE(processedAt, placedAt)`) AFTER `AiGeneration.createdAt` ⇒ bought again SINCE we decided ⇒ suppress. **SINCE-GENERATION, not a fixed N-day window** (8.3 supersession — see G-Q6) |
| 4 | **Frequency floor** | terminal | suppressed (`'frequency'`) | EXISTING `MerchantSettings.defaultCooldownHours` (7d) + `maxDailySendsPerCustomer` (1) vs the customer's `Message.sentAt` history — suppress if inside the cooldown or over the daily per-customer count (no new field) |
| 5 | **Quiet-hours / send-time** | transient | **re-queue** for next tick (draft NOT burned) | `Merchant.timezone` + `MerchantSettings.sendTimeStartHour/EndHour` |
| 6 | **Quota** | transient | **re-queue** | `MessageQuotaBucket` vs BOTH `MerchantSettings.dailySendCap` (day's count) AND `monthlySendsCap` (month's summed buckets) — pre-flight read; authoritative check+increment under the row lock in the send tx (G-Q9) |

**Terminal** (1–4) write `Message.status=suppressed` + the `CampaignTarget` forensic gate label and are done. **Transient** (5–6) re-queue without burning the draft; the next scheduler tick re-evaluates from gate 1 (conditions may have changed).

---

## Send path

After the gate chain passes:
1. **Send via SendGrid** (external HTTP — OUTSIDE any tx, locked rule). The email body = `Message.generatedText` (already discount-substituted by A4). A pre-send `status=draft` guard + SendGrid idempotency key (keyed on `Message.id`) guards against duplicate sends on retry (see Edge cases).
2. **Completion tx (atomic, G-Q9):** `SELECT … FOR UPDATE` the day's `MessageQuotaBucket` → **authoritative cap check under the lock** (abort + re-queue if the day's `sentCount >= dailySendCap` OR the month's summed `sentCount >= monthlySendsCap` — no double-spend across concurrent sends) → increment `sentCount` → `Message.status=sent` + `sentAt` + `channel=email` + `provider='sendgrid'` (updateMany WHERE `status=draft` — race-replay guard) → `CampaignTarget.status=sent` → `MessageEvent(type=sent)`.
3. **Report to Marketing Activities** (external, AFTER the tx — G-Q4): register/update the Shopify marketing activity + outcome. Failure here is non-fatal (logged; the send already succeeded).
4. **Async — SendGrid event webhooks** → a web route ingests `delivered/open/click/bounce/spamreport` → writes `MessageEvent` (idempotent on `providerEventId`) and advances `Message.status` (high-water-mark). **`bounce` / `spamreport` / unsubscribe-link click → write a `Suppression` row** (reason `bounce`/`complaint`/`unsubscribe`) so future sends to that customer are gated at gate 1.

---

## Drift-flaw resolution (G-Q6)

The A1-parked missed-webhook gap (verbatim source: `POST-EPIC-F-CONSCIOUS-DECISION.md:615-641`) is resolved at the dispatch boundary by **gate 3 (freshness)**: before sending a winback, check whether the customer placed a qualifying local `Order` AFTER we decided to winback; if so, the "lapsed" signal is stale (drifted scoring or a missed webhook) — suppress. This neutralizes the *consequence* (firing at an actively-buying customer) without requiring the full order-reconciliation sweep, which remains DEFERRED future hardening (it fixes the *cause* — recovering missed order events — and is distinct from both the order-backfill we built in `fdebc11` and the webhook-subscription cron in §11.2).

**8.3 supersession — SINCE-GENERATION, not a fixed N-day window.** The build implements gate 3 as `OrderRepository.hasQualifyingOrderSince({ customerId, since: AiGeneration.createdAt })` — a qualifying order whose recency is strictly AFTER the generation/decision timestamp. Rationale: a fixed N-day window would over-suppress on purchases ALREADY accounted for in the lapse decision (a customer legitimately flagged `dormant` has an old last-order that must NOT block the winback); only a purchase NEWER than the decision is genuine drift (one our scoring never saw). A5's 24h generation-staleness skip already bounds how old `since` can be, so no extra outer look-back floor is needed. The qualifying-order definition is shared with A3's `findRecentPurchasedTitles` (`financialStatus IN ('paid','partially_paid')`, `isTest=false`, recency `COALESCE("shopifyProcessedAt","placedAt")`).

---

## Consent / compliance model (G-Q7)

- **Channel-specific consent** — `Customer.emailMarketingConsentState`, ingested from Shopify (above), is the v1 gate (gate 2). Fails closed (`not_subscribed` default).
- **Suppression** — the `Suppression` table is the hard-stop list, fed by unsubscribe-link clicks, SendGrid bounces, spam complaints, and manual operator entries. Gate 1, runs first.
- **CAN-SPAM** — every email carries a working unsubscribe link (a tokenized web route that writes a `Suppression` row + sets `emailMarketingConsentState=unsubscribed`), honored immediately (well within the 10-day rule), plus the merchant's physical postal address in the footer (merchant-config or Shopify shop address). **The unsubscribe token MUST be HMAC-derived and unguessable — `HMAC(secret, messageId:customerId)`, NOT an enumerable row id** — because the route is public + unauthenticated and gates a destructive action (suppressing a customer); a guessable/enumerable token would let anyone unsubscribe anyone (griefing + deliverability sabotage). Same unforgeable-token reasoning as A4's discount code.
- **GDPR** — unsubscribe + the existing customer-redact cascade (Suppression/MessageEvent CASCADE on customer delete) cover erasure.
- **SMS consent + STOP** — DEFERRED with SMS (G-Q1).

---

## Attribution seam (CP-2 / H1)

`MessageEvent` rows are H1's attribution input. H1 (runs parallel after this batch's schema lands) matches an order placed within `MerchantSettings.attributionDirectWindowDays` of a `MessageEvent(sent)` to that message. The **customer-scoped discount code** (A4) is a second, stronger attribution signal — a redemption of `AiGeneration.discountCode` is directly attributable. v1 captures `MessageEvent` correctly; the matcher is H1's scope, not G's.

---

## Deferred-items register (WHY each is deferred)

| Item | Why deferred | Unblocks when |
|---|---|---|
| **SMS channel** | TCPA express opt-in + STOP + Twilio 10DLC ≈ doubles compliance/integration scope; email delivers v1 value. | A dedicated SMS batch (own consent field + STOP→Suppression + carrier reg). |
| **Workflow engine** | Multi-touch generated sequences collide with EPIC-F Q4 ("G does not trigger generation"); single-touch ships the core value. | A later batch resolving drip-resend vs a Q4 amendment (written counter-proposal). |
| **Segment engine** | v1 targets trigger-band + consent off existing data; RFM/tag/custom-field segments are additive, don't restructure dispatch. | §8.5 when richer audiences are needed. |
| **Order-reconciliation sweep** | The freshness gate (G-Q6) covers the *consequence* in v1. | Future hardening if missed-webhook drift proves material at real-merchant scale. |
| **Per-campaign frequency engine** | v1 reuses the per-customer floor (G-Q8 — existing `defaultCooldownHours` + `maxDailySendsPerCustomer`); per-campaign caps need the Workflow/multi-touch model. | With Workflow. |

---

## Open design points for the dispatch-worker batch (NOT 8.1 schema)

- **Send idempotency:** the send (external) precedes the completion tx; a crash between them could double-send on retry. v1 guard = pre-send `status=draft` check + SendGrid idempotency key on `Message.id`. Confirm at-least-once-with-guard is acceptable vs a stronger exactly-once protocol.
- **Quota overshoot:** the pre-flight quota check (gate 6) + authoritative in-tx increment (G-Q9) admits a small overshoot under concurrent sends (we may send a few past the cap before the lock serializes). Accept (bounded by worker concurrency), like A4 accepts wasted-spend on race.
- **`MessageStatus` high-water-mark** — RESOLVED (APPROVED): high-water-mark + the monotonic-ordering requirement (note ‡); the dispatch/webhook code enforces `sent < delivered < opened < clicked` and never regresses.
- Dispatch worker placement: shared `apps/drainer` queue vs dedicated.

---

## Revised batch plan (email-first) — SUPERSEDES §8's 9-batch plan

Supersession-with-pointer, NOT a silent replacement: the deferred SMS / Workflow / Segment work RETURNS in its own later sections written from this doc (see the Deferred-items register's "Unblocks when" column) — it is sequenced out of v1, not dropped.

### Skeleton-first re-decomposition — SUPERSEDES the table above (2026-06-11)

The original table bundled **8.3 = dispatch worker + gate chain + send/completion-tx + scheduler tick** behind **8.2 = SendGrid provider**. That bundles three independently-riskable concerns (the pickup/claim plumbing, the gate logic, and the external send) into one batch, and front-loads the ESP adapter before the machinery that uses it exists.

Re-decomposed **skeleton-first** so each layer ships + is verified before the next builds on it: prove the pickup → claim → idempotency foundation first, THEN the gate chain over claimed targets, THEN the external send. Rationale parallels the §8→email-first supersession (sequence the riskable pieces, don't bundle them). Net effect: the old 8.3 splits into new 8.2/8.3/8.4, the old 8.2 SendGrid provider folds into the new 8.4 (built alongside the send that consumes it), and 8.4–8.7 shift down by one to 8.5–8.8.

| Batch | Scope |
|---|---|
| **8.1 (done)** | `EPIC-G-DESIGN.md` + schema: the 5 tables, `Message` alters, the 4 new enums + `MessageStatus` ALTER, `Customer.emailMarketingConsentState` + **its ingestion path** (webhook body + backfill + upsert), `TENANT_SCOPED_MODELS` + cascade-policy header. One migration (+ hand-authored `ALTER TYPE`). |
| **8.2 (this batch) — dispatch skeleton** | `campaign.dispatch` queue + `SYSTEM_SCOPE_REASONS.campaign.dispatch_sweep`; the `dispatch-sweep` tick (15-min, on `cron.sweep`) → `CampaignRepository.findDispatchableDrafts` PICKUP (completed+non-empty draft, active email campaign band-match, **oldest-campaign `createdAt ASC` tiebreak**, soft-delete + `NOT EXISTS CampaignTarget` filters) → per-draft `campaign.dispatch` jobs; the dispatch Worker (in `apps/drainer`) CLAIMS each via `CampaignTarget(pending)`, idempotent on `messageId @unique`. NO gates, NO send — `Message.status` stays `draft`. |
| 8.3 — gate chain | The 6 terminal→transient gates (G-Q10 order) over claimed `CampaignTarget(pending)` rows: Suppression · Consent (`emailMarketingConsentState=subscribed`) · Freshness (G-Q6) · Frequency (existing `defaultCooldownHours`+`maxDailySendsPerCustomer`) · Quiet-hours (re-queue on out-of-window, the 15-min tick re-checks) · Quota (vs `dailySendCap`/`monthlySendsCap`). |
| 8.4 — SendGrid provider + send | SendGrid email provider (`packages/messaging`?) — adapter mirroring `packages/ai`'s `AiProvider`, mocked-SDK unit tests — **plus** the external send + the G-Q9 quota-under-lock mark-sent completion tx (`Message.status` → `sent`, `CampaignTarget` → `sent`, `MessageQuotaBucket` increment). |
| 8.5 | SendGrid event-webhook ingest route → `MessageEvent` + Suppression-on-bounce/complaint; CAN-SPAM unsubscribe route. |
| 8.6 | Campaign CRUD + Marketing Activities reporting (G-Q4). **Build-note:** warn/prevent overlapping `triggerStates` across active campaigns — the 8.2 `createdAt ASC` tiebreak is the deterministic safety net for that misconfiguration, not a routine choice. |
| 8.7 | UI shell — campaign builder + send-time settings (Polaris). |
| 8.8 | Integration tests (real Postgres + mocked SendGrid) — draft → claim → gate chain → send → MessageEvent end-to-end. |

(SMS, Workflow, Segment get their own later sections, written from this doc.)

---

## Q-locks established by this doc
G-Q1 (email-first) · G-Q2 (Workflow deferred, respects EPIC-F Q4) · G-Q3 (Segment deferred) · G-Q4 (ESP-sends + MA-reports) · G-Q5 (queued + scheduler-tick) · G-Q6 (freshness gate; reconciliation deferred) · G-Q7 (channel-specific consent + Suppression + CAN-SPAM, mandatory v1) · G-Q8 (frequency floor v1-lite) · G-Q9 (quota increment in the send tx) · G-Q10 (terminal-before-transient gate order) · G-Q11 (Billing = launch-gate) · G-Q12 (discount consumed from AiGeneration).

End of EPIC-G-DESIGN.md (ACTIVE).
