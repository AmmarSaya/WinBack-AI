# POST-EPIC-F-CONSCIOUS-DECISION.md — v1 launch roadmap

**Status:** DRAFT — awaiting founder review and approval before referenced in any commit.
**Scope:** The conscious-decision arc *after* Epic F closes — Path 3 (M10 one-liners), Path 1 (Epic G), Epic H1 in parallel with G, Billing API, hardening pass, App Store listing prep. Path 2 (operator pre-launch env + Partners portal sync) interleaved.
**Companion docs:** `handoff.md` (live state), `ARCHITECTURE.md` (locked policies), `CP2-ATTRIBUTION-CONTRACT.md` (Epic H1 contract), `EPIC-F-DESIGN.md` (current epic), `SHOPIFY-SCOPES-AUDIT.md` (8-scope union locked), `POINTS-TO-CONSIDER.md` (live tracker).
**Schema reference:** `packages/db/prisma/schema.prisma` at `main` SHA `9220acb` (Epic F batch 1 will be the next commit to touch it).

This document is a permanent contract. Any future change to v1 scope, channel selection, attribution depth, or launch sequencing MUST update this file in the same commit.

---

## Locked v1 decisions (read first)

Generated from senior architect review session, 2026-05-21. Founder approved 2026-05-21.

| Q | Lock | Source |
|---|---|---|
| V1 — Channels | **Email + SMS only. WhatsApp deferred to v1.1.** Meta Business Verification + WhatsApp Business API provider + per-template approval is a 3-4 week rabbit hole with zero impact on initial willingness-to-pay. | Review session |
| V2 — AI feature surface | **Messages WITH AI-generated discount codes.** Founder accepts the 8-scope install-screen friction in exchange for a richer pitch and a defensible attribution loop (a customer-scoped discount code is its own attribution signal). | Founder decision |
| V3 — Attribution depth | **Direct AND Assisted on the dashboard, both labeled.** Per CP-2 contract. Direct-only undersells; assisted-only is hard to defend; both together is the industry-standard pattern (Klaviyo / Postscript). | Founder decision |
| V4 — Shopify scopes | **8-scope union per `SHOPIFY-SCOPES-AUDIT.md`.** No re-evaluation in v1. | `SHOPIFY-SCOPES-AUDIT.md` (locked 2026-05-21) |
| V5 — Pricing model | **3 flat monthly tiers via Shopify Recurring Application Charges, banded by Customer count (NOT order volume, NOT send volume). 14-day trial. Platform absorbs LLM cost.** Customer count is intuitive to merchants and exposed reliably by the Admin API. Tier prices remain TBD (founder fills before Billing API ships). | Review session |
| V6 — Target merchant for v1 | **English-speaking, single-currency, mid-size DTC (5K–50K customers).** Multi-currency dashboard widgets and i18n are v1.1. Schema captures multi-currency data correctly from day one; v1 just doesn't render it. | Review session |
| V7 — LLM provider freeze for launch | **Pick ONE launch provider and freeze it.** Provider abstraction is preserved (Epic F's `AI_PROVIDER` env flip still works), but the launch provider is documented and any change requires a margin re-baseline before flipping production env. Founder picks before Section 1 ships. | Review session |
| V8 — Honest timeline | **~18 weeks (4.5 months) from end-of-Epic-F to App Store listing live**, including a budgeted Shopify review-rejection-resubmit cycle. Founder originally targeted <3 months; revised on review of the realistic Epic-G + Epic-H + Billing API + listing prep math. | Founder decision |
| V9 — Discount text safety | **AI never writes raw discount codes or percentages.** Prompt instructs the LLM to emit `{{DISCOUNT_CODE}}` and `{{DISCOUNT_VALUE_PERCENT}}` tokens; a deterministic post-processor substitutes the real values from the Shopify-created discount row. Eliminates the AI-hallucinated-discount support category before it exists. | Review session |
| V10 — First-pass scoring suppression | **The first-ever scoring pass for a new merchant writes `CustomerScore` rows but does NOT emit `customer.state_changed` outbox events.** Prevents the AI Worker storm on install day (15K simultaneous transitions for a 50K-customer merchant). Tracked via `Merchant.scoringInitializedAt`. | Review session |

---

## Explicitly OUT of v1 (do not reintroduce without rewriting V1–V10)

- WhatsApp channel
- Multi-currency dashboard widgets (data captured, not rendered)
- Per-merchant AI provider selection
- Prompt versioning / A/B testing
- Operator-editable cost-rate table (`PROVIDER_COST_RATES` stays hardcoded)
- Cross-provider failover (same-provider retry only per Epic F Q9)
- Human review queue (merchant approves campaigns, not individual messages)
- Backfill generation for pre-existing at-risk customers
- Multi-language generation (`read_locales` scope deferred)
- Branching workflows (linear up to 5 steps in v1; branching = v1.1)
- Storefront / theme app extensions (server-to-server only; offline tokens already lock this)
- Order refund attribution *deletion* (reversal via `reversed` flag is in scope; row deletion is not)

---

## Path resequencing (corrects `handoff.md` "What's NEXT" section)

`handoff.md` frames the post-Epic-F decision as Path 1 (Epic G) vs Path 2 (operator) vs Path 3 (M10 one-liners). On review, the three are not mutually exclusive — they're sequenced + interleaved:

| Order | Path | Reason |
|---|---|---|
| 0 (now) | Finish Epic F batches 2–5 | Already underway. No change. |
| 1 (after F) | **Path 3 — M10 one-liners** | Cheap to do before more code piles on top. The C-5, M-1, S-5 scope assertions are footguns that grow more dangerous as Epic G adds new tenant-scoped models. Doing them BEFORE Epic G is half a session; doing them AFTER means revisiting every G call site. |
| 2 (parallel with rest) | **Path 2 — operator tasks** | 1 hour of founder time. Slot it in whenever before week 14. Both blockers (`SHOPIFY_SCOPES` prod env + Partners Dashboard sync) are documented in `SHOPIFY-SCOPES-AUDIT.md`. |
| 3 (main thrust) | **Path 1 — Epic G** | Largest scope. Multi-session. Drives v1 product surface. |
| 4 (parallel with G) | **Epic H1 — Attribution** | CRITICAL: Starts after G batch 1 (design doc + schema locked), runs alongside G batches 2–9. Sequential H1 after G means launching with $0 on the dashboard. |
| 5 (overlaps G + H1) | **Billing API integration** | Starts mid-Epic-G. Cannot take money without it. Pricing tiers locked before this section begins. |
| 6 (after G + H1) | **Pre-launch hardening pass** | Remaining `POINTS-TO-CONSIDER` M10 items + new items from this review. |
| 7 (parallel with #6) | **App Store listing prep** | Founder work + Claude-doable subset. Submit at week 14. Review cycle 5–15 business days; budget one rejection + resubmit. |

The conscious decision in `handoff.md` is *resolved* by this doc: it's not "Path 1 vs Path 2 vs Path 3" — it's "Path 3 → Path 2 (anytime) → Path 1 + H1 in parallel → Billing → hardening + listing."

---

## Founder-only blocker: design partner outreach

**This is the highest-priority non-code task in the entire v1 arc.** Five named merchants who agree in principle to be your first installs, weeks 14–16. Outreach must start in week 1 of post-Epic-F work — relationship-building has lead time that cannot be compressed at the end.

Ideal partner profile:
- Shopify Standard / Advanced / Plus (Basic lacks order volume for win-back to matter)
- 5K–50K total customers
- 1+ year operating history (has actual dormant customers)
- Already paying for at least one retention tool (knows the category, willing to compare)
- English-speaking owner who responds to messages

Outreach channels: LinkedIn (Shopify operator filter), Twitter/X (active DTC community), Pakistan B2B network via Union Fabrics suppliers' D2C side projects, Shopify Community forum threads about retention. Cold email is fine.

Offer: free 6 months of the highest tier in exchange for monthly 30-minute feedback calls + logo permission for landing page.

**Block 1 hour daily for outreach starting Section 1 of this doc. Do not defer to "after the code is done." The math doesn't work.**

---

## Policy decisions

### S-1 — Per-batch audit gate inherited from Epic E / Epic F

Every section below ships as one or more batches under the established per-batch audit-gate flow:

1. Section opens with a batch plan (file list + commit message preview).
2. Claude Code surfaces ACTUAL FILES on disk, not summaries.
3. Founder audits files.
4. Commit locally only on explicit sign-off.
5. Push only on explicit instruction.
6. Multi-batch sections (Epic G especially) gate per-batch — never bundle batches.

The "deliver → user audits ACTUAL FILES (not summaries) → fix → approval → commit + push" rule from `handoff.md` governs every section.

### S-2 — Design-doc-in-batch-1 pattern

Every new epic (G, H1) lands its `EPIC-X-DESIGN.md` in the SAME commit as the batch-1 schema migration, matching Epic E session 2 and Epic F batch 1. Reviewer reads doc + schema together; ungated doc commits create review whiplash.

### S-3 — Registry-first additions

Per existing standing rule: every new `SYSTEM_SCOPE_REASONS`, `QUEUE_NAMES`, `AUDIT_ACTIONS` entry registered in `@winback/contracts` BEFORE use at the call site. Doc sections below name every new registry entry explicitly so the founder can verify completeness during audit.

### S-4 — Architectural locks unchanged

V1–V10 above add product/scope locks. The 25 ARCHITECTURE locks in `handoff.md` (multi-tenancy, BigInt cents, UTC, soft-delete, outbox, AsyncLocalStorage, etc.) are not revisited. Any v1 section that tempts a violation gets a written counter-proposal in `ARCHITECTURE.md` before code lands.

### S-5 — Decision under uncertainty: defensive defaults

Where v1 sections require new Shopify API surface (e.g., Marketing Activities API in Epic G, Billing API confirmation flow), default fields to `.optional()` and assertions to defensive checks until production data proves the field is always populated. Same rule as the existing Shopify decode pattern.

---

## Section register

Every section below is a self-contained unit of work. Each has: locked-decision context, batch plan, file surface, registry additions, test surface, the Claude Code prompt block. Sections are ordered by execution sequence; do not skip ahead.

| Section | Title | Estimated effort | Path |
|---|---|---|---|
| 1 | First-pass state-transition suppression | 3 days, 1 batch | Path 1 prerequisite |
| 2 | Per-merchant generation rate limiting | 2 days, 1 batch | Path 1 prerequisite |
| 3 | Local-DB recent products (drop Shopify API read) | 1 day, 1 batch | Path 1 prerequisite |
| 4 | Discount placeholder substitution + creation + cleanup | 3 days, 3 batches | Path 1 prerequisite |
| 5 | Time-bounded stale generation retry | 1 day, 1 batch | Path 1 prerequisite |
| 6 | Path 3 — M10 one-liner scope assertions (C-5, M-1, S-5) | 0.5 day, 1 batch | Path 3 |
| 7 | Path 2 — Operator pre-launch (prod env + Partners portal) | 1 hour | Path 2 (founder) |
| 8 | Epic G — Campaigns, segments, workflows, dispatch | 6–8 weeks, 9 batches | Path 1 |
| 9 | Epic H1 — Direct + Assisted attribution | 3–4 weeks, 5 batches | Path 1 parallel |
| 10 | Shopify Billing API integration | 2 weeks, 4 batches | mid-G |
| 11 | Pre-launch hardening pass | 1–2 weeks, multi-batch | post-G |
| 12 | App Store listing prep | 1–2 weeks, multi-batch (mostly founder) | post-G |

Sections 1–5 are immediate post-Epic-F fixes. They are NOT "nice to have" — they are correctness defenses that Epic F's design surface implies but does not implement. Skipping any of them imports a known failure mode into v1.

---

## Section 1 — First-pass state-transition suppression

### Lock V10 in effect

First-ever scoring pass for a merchant writes `CustomerScore` rows but does NOT emit `customer.state_changed` outbox events. From scoring pass 2 onward, events emit normally.

### Why this exists

Epic E session 2 closed without modeling the install-day storm. A merchant with 50K customers transitions ~30% into `at_risk` / `dormant` / `lost` on first scoring pass. Each transition is a `customer.state_changed` event. Each event is an `ai.generate` job. Each job costs money, locks per-merchant BullMQ concurrency, and produces a draft `Message` row. Without suppression: install day = AI Worker monopolized for hours, real LLM spend on customers who got onboarded into states (not who *transitioned* to them), confused merchant.

### Batch plan

**Batch 1.1 (single batch):**

Schema:
- `Merchant.scoringInitializedAt DateTime?` (new column)
- Prisma migration `<ts>_merchant_scoring_initialized`

Code:
- `CustomerScoreService.recompute` checks `merchant.scoringInitializedAt`. If null → write scores, suppress `customer.state_changed` outbox event emission. Last batch of the first pass sets `scoringInitializedAt = now()` in the same tx.
- Audit log entry written in same tx as the flag flip.

Registry additions:
- `AUDIT_ACTIONS.merchant.scoring_initialized`

Test surface:
- Unit: scoring service suppresses outbox events when `scoringInitializedAt` is null.
- Unit: scoring service emits outbox events when `scoringInitializedAt` is set.
- Unit: flag flip is atomic with the last batch of the first pass.
- Integration: full first-pass run on a fixture merchant writes scores + audit log, zero outbox events.
- Integration: second-pass run after `scoringInitializedAt` is set emits events normally for state changes.

### Claude Code prompt

```
Implement v1 Section 1: First-pass state-transition suppression.

Context (read first):
- handoff.md (current state, ARCHITECTURE locks)
- EPIC-E-SESSION-2-DESIGN.md (CustomerScoreService.recompute contract)
- POST-EPIC-F-CONSCIOUS-DECISION.md Section 1 + Lock V10
- packages/db/prisma/schema.prisma (Merchant + CustomerScore models)

Constraints:
- Suppression is PRODUCER-side (CustomerScoreService.recompute), not CONSUMER-side. Do NOT modify Epic F's handleCustomerStateChanged.
- The flag-flip MUST be atomic with the final batch write of the first pass — partial-failure must leave scoringInitializedAt null so the next run re-attempts as "first pass."
- Audit log written in same tx as the flag flip (AUDIT_ACTIONS.merchant.scoring_initialized — register first in @winback/contracts).
- Tenant-safe writes throughout — CustomerScoreService already runs under withTenantScope; the Merchant update uses the existing repository chokepoint pattern.

Batch surface (one batch):
1. Add scoringInitializedAt DateTime? to Merchant in schema.prisma
2. Generate Prisma migration <ts>_merchant_scoring_initialized
3. Register AUDIT_ACTIONS.merchant.scoring_initialized in @winback/contracts
4. Modify CustomerScoreService.recompute to gate outbox emission on scoringInitializedAt
5. Update tests in packages/db/tests/customer-score.service.test.ts
6. Add integration test verifying zero outbox events on first pass

Surface ACTUAL FILES for audit. Await founder sign-off before commit.
```

---

## Section 2 — Per-merchant generation rate limiting

### Why this exists

Even with Section 1, a single merchant with legitimate state-change volume (e.g., daily Black Friday cohort transitions) can monopolize the AI Worker because Epic F's `per-merchant concurrency = 1` is a blunt instrument. Without a per-merchant rate ceiling, one merchant's burst starves the rest.

### Lock

`MerchantSettings.hourlyGenerationCap Int @default(100)`. Default 100 generations/hour. Operator-adjustable later via settings UI (no v1 UI surface — direct DB or operator CLI only).

### Batch plan

**Batch 2.1 (single batch):**

Schema:
- `MerchantSettings.hourlyGenerationCap Int @default(100)`
- Prisma migration `<ts>_merchant_settings_hourly_gen_cap`

Code:
- `packages/queue/src/rate-limiter.ts` — new module exporting `incrementAndCheck(merchantId, capPerHour): { allowed, currentCount }`. Redis `INCR` + `EXPIRE` on key `ai:gen:rate:<merchantId>:<UTC-hour-bucket>` with 1-hour TTL.
- AI Worker checks rate limit BEFORE the spend-ceiling check. Rejection → `AiGeneration.status = failed`, `lastError = 'hourly_generation_cap_exceeded'`, no LLM call, no spend bucket increment.

Registry additions:
- `AUDIT_ACTIONS.ai.rate_limited`

Test surface:
- Unit: rate limiter respects cap, hourly bucket rolls over at top-of-hour UTC.
- Unit: Redis `INCR` atomicity already gives us race safety — test that concurrent calls don't double-count.
- Unit: AI Worker rejects with correct `lastError` when over cap.
- Integration: 101 jobs enqueued, first 100 process normally, 101st marked rate-limited.

### Claude Code prompt

```
Implement v1 Section 2: Per-merchant generation rate limiting.

Context (read first):
- handoff.md
- EPIC-F-DESIGN.md F-6 (spend ceiling pattern — model the rate limiter similarly)
- POST-EPIC-F-CONSCIOUS-DECISION.md Section 2

Constraints:
- DO NOT change Epic F's per-merchant BullMQ concurrency = 1. The rate limit is a SEPARATE defensive layer.
- Rate limit check runs BEFORE spend-ceiling check in the AI Worker. Cheap rejection before any DB write.
- Redis key TTL = 1 hour. Hour bucket = UTC `Math.floor(Date.now() / 3_600_000)`.
- ioredis client shared with the rest of the queue layer.

Batch surface (one batch):
1. MerchantSettings.hourlyGenerationCap Int @default(100) + migration
2. packages/queue/src/rate-limiter.ts new module
3. AI Worker modified to call incrementAndCheck before spend-ceiling check
4. AUDIT_ACTIONS.ai.rate_limited registered
5. Unit + integration tests

Surface ACTUAL FILES. Await sign-off.
```

### Implementation note (A2, 2026-06-10): gate-point resolution

The Phase-1 trace surfaced a self-contradiction in this section's prose
that had to be resolved before implementation. Recording the resolution
here so the next reader doesn't re-litigate it:

- The literal text says "AI Worker checks rate limit BEFORE the
  spend-ceiling check," but the spend-ceiling check is NOT in the AI
  Worker. It lives in the **handler** (`handleCustomerStateChanged`
  STEP 5; EPIC-F-DESIGN §F-9 line 393 — "Cheap denial before any DB
  write. WITHOUT creating an `AiGeneration` row").
- The section's explicit constraint — "Cheap rejection before any DB
  write" — rules out the worker as the gate point. By the time the
  worker runs, the `AiGeneration` + `Message` + `OutboxEvent` rows
  ALREADY exist (the handler created them). Putting the cap in the
  worker would write 4 rows per cap-hit and defeat the burst-starvation
  defence's reason for existing.
- The section's pattern reference — "model the rate limiter on the
  spend-ceiling pattern" — also pins the gate to the **handler**
  (`ai.spend_cap_exceeded` audit-as-record, no AiGeneration row on
  denial).

**Resolution: gate in `handleCustomerStateChanged` BEFORE the
spend-ceiling check (call it STEP 4.5 inline).** Cap-hit emits
`AUDIT_ACTIONS.ai.rate_limited` and returns; NO `AiGeneration` row is
created. The literal-text mention of `AiGeneration.status = failed`
with `lastError = 'hourly_generation_cap_exceeded'` is moot — there's
no row to set it on.

Other locked implementation details (Phase-1 sign-off):

- **Lua atomicity**: INCR + conditional EXPIRE (if return == 1) in ONE
  Lua script, cached via `SCRIPT LOAD` + `EVALSHA`. A client crash
  between INCR and EXPIRE would leave a TTL-less key — that merchant
  permanently capped at whatever count the key reached. Correctness,
  not perf.
- **Connection sharing**: rate-limiter uses the shared `'queues.shared'`
  ioredis client via a new sanctioned export `getQueueLayerClient()`.
  Safe because INCR/EVALSHA are non-blocking commands — same property
  that lets all BullMQ Queues share the connection. Workers (blocking
  commands: BLPOP, BRPOPLPUSH) still get their own connections.
- **Audit context shape**: `{ currentCount, hourlyGenerationCap,
  hourBucket, eventId }`. `merchantId` is the top-level `AuditLog`
  column (NOT duplicated into context) so "which merchants hit their
  cap this hour" is an indexed query, not a JSON-parse scan. This audit
  is load-bearing observability — the only signal that a merchant is
  losing winbacks to the cap.
- **Cap-hit behavior**: §2's DROP (no defer, no backlog) is accepted
  for v1. **Known limitation**: a merchant routinely exceeding
  100/hour (large merchant, sale-end re-band burst) silently loses
  legitimate winbacks. Detection signal is the `ai.rate_limited`
  audit. Mitigations before onboarding a large merchant: per-merchant
  cap tuning (the column supports it) or a deferral mechanism
  (separate future scope). Tracked in handoff carry-forwards.

---

## Section 3 — Local-DB recent products (drop Shopify API read)

### Why this exists

Epic F F-9 step 6 calls the Shopify Admin GraphQL API to fetch recent products for the prompt's context block. That data is already in your local Postgres (`OrderLineItem` rows from `orders/create` webhook backfill). The API call costs latency, a leaky-bucket token, and an unnecessary failure surface — for data you already have.

Side benefit: prompt construction becomes resilient to Shopify API outages. Only the `read_price_rules` lookup (for active discounts) remains as an external dep, which is unavoidable since price rules aren't synced to local DB.

### Batch plan

**Batch 3.1 (single batch):**

Code:
- `handleCustomerStateChanged` — replace Shopify Admin API call for recent products with a Prisma query: last 3 paid Orders by `placedAt DESC`, include `OrderLineItems`, take first line item per order (the "primary item"). Filter `financialStatus IN ('paid', 'partially_paid')`.
- `read_price_rules` call retained — price rules are live data.
- Header comment documents rationale: "Recent products read from local DB (OrderLineItem) not Shopify API — data is already synced via orders/create webhook backfill."

Test surface:
- Unit: customer with 0 prior orders returns empty `recentProducts`.
- Unit: customer with 5+ prior orders returns most recent 3.
- Unit: query is tenant-scoped (Prisma extension covers this — test confirms no cross-tenant leak).
- Integration: full handler run with seeded order history populates prompt correctly.

### Claude Code prompt

```
Implement v1 Section 3: Replace Epic F's Shopify API "recent products" read with a local Prisma query.

Context (read first):
- EPIC-F-DESIGN.md F-7 (WinbackPromptArgs.recentProducts) + F-9 step 6
- packages/db/prisma/schema.prisma (Order + OrderLineItem)
- POST-EPIC-F-CONSCIOUS-DECISION.md Section 3

Constraints:
- DROP the Shopify Admin GraphQL "recent products" call from handleCustomerStateChanged.
- KEEP the read_price_rules call (live data).
- Prisma query: customer's most recent 3 Orders by placedAt DESC, financialStatus IN ('paid', 'partially_paid'), include OrderLineItems, take first OrderLineItem per order.
- Document the rationale at the top of the handler.

Batch surface (one batch):
1. Modify apps/drainer/src/handlers/customer-state-changed.ts
2. Update unit tests in apps/drainer/tests/handlers/customer-state-changed.test.ts
3. Update integration tests if any cover the recent-products surface

Surface ACTUAL FILES. Await sign-off.
```

---

## Section 4 — Discount placeholder substitution + creation + cleanup

### Lock V9 in effect

AI never writes raw discount text. Prompt instructs LLM to emit `{{DISCOUNT_CODE}}` and `{{DISCOUNT_VALUE_PERCENT}}` tokens. Deterministic post-processor substitutes the real values.

### Why this exists

Choosing V2 (messages WITH AI discounts) imports a known LLM failure mode: hallucinated discount text. The LLM, given freedom to write "use code WELCOME20 for 20% off," will eventually write a code that doesn't exist or a percentage that doesn't match the discount you actually created. Result: support tickets, broken trust, refund disputes. Placeholder tokens close the entire failure class — the LLM can't hallucinate a code it doesn't generate.

Three sub-deliverables: prompt-side instruction, post-processor substitution, and discount lifecycle (Shopify discount creation + expiry + cleanup cron).

### Batch plan

**Batch 4.1 — Prompt-side + substitutor (1 day):**

Code:
- `packages/ai/src/prompt-builder.ts` — system prompt instructs LLM on token usage. User prompt's discount-context section uses tokens, never literal values.
- `packages/ai/src/discount-substitutor.ts` — new pure module. `substituteDiscountTokens(text, { code, valuePercent }): string`. Global replace of `{{DISCOUNT_CODE}}` and `{{DISCOUNT_VALUE_PERCENT}}`.
- AI Worker calls substitutor AFTER LLM response, BEFORE `Message.generatedText` write.

Test surface:
- Unit: no placeholders → text unchanged.
- Unit: both placeholders → both substituted globally.
- Unit: missing placeholder in text + warning logged (LLM ignored the instruction — fail safe, not silently).
- Unit: prompt builder emits tokens, not literal values, regardless of the discount value passed in.

**Batch 4.2 — Shopify discount creation (1 day):**

Schema:
- `AiGeneration.discountCode String?`
- `AiGeneration.discountValuePercent Int?`
- `AiGeneration.shopifyDiscountId String?` (for reconciliation / cleanup)
- Prisma migration `<ts>_ai_generation_discount_columns`

Code:
- `packages/shopify/src/discounts.ts` — new module. `createWinbackDiscountCode(merchantId, customerId, valuePercent, expiresAt): { code, shopifyDiscountId }` via Shopify `discountCodeBasicCreate` mutation. Code format: `WB-<cuid first 4>-<random 4>`. Customer-scoped (single use, `customerSelection` set to the specific customer GID).
- AI Worker — BEFORE building the prompt: create discount, pass code + valuePercent + shopifyDiscountId into the generation row + prompt builder.
- Discount expiry = `MerchantSettings.attributionDirectWindowDays` days from creation. Single source of truth for the window.

Registry additions:
- `AUDIT_ACTIONS.discount.created`

Test surface:
- Unit: discount creation mutation builds the right GraphQL input (mocked Shopify client).
- Unit: code format respects the convention.
- Unit: AI Worker writes discount columns on `AiGeneration` before the LLM call.
- Integration: full handler run creates a Shopify discount (mocked), passes correct values to prompt builder.

**Batch 4.3 — Expiry cleanup cron (1 day):**

Code:
- `apps/scheduler/src/jobs/discount-cleanup.ts` — new cron at `cron.discount-cleanup`, daily 02:00 UTC.
- Queries `AiGeneration` for rows with `shopifyDiscountId IS NOT NULL` and `createdAt < now() - attributionDirectWindowDays`. Deletes from Shopify via `discountCodeDelete` mutation. Idempotent — re-running is safe (404 from Shopify treated as already-deleted).

Registry additions:
- `QUEUE_NAMES.discount.cleanup`
- `AUDIT_ACTIONS.discount.expired`

Test surface:
- Unit: cron picks up only expired rows.
- Unit: 404 from Shopify treated as success (idempotent).
- Unit: audit log written per deletion.
- Integration: full cron tick deletes expired discounts and writes audit rows.

### Claude Code prompt (3 batches — gate each)

```
Implement v1 Section 4 in 3 batches. Gate per batch — surface files, await sign-off, commit, then next batch.

Context (read first):
- EPIC-F-DESIGN.md F-7 (prompt construction)
- packages/ai/src/prompt-builder.ts
- packages/shopify/ (Admin GraphQL client + cost tracker)
- POST-EPIC-F-CONSCIOUS-DECISION.md Section 4 + Lock V9

BATCH 4.1: Prompt-side instruction + substitutor (no schema, no Shopify calls)
- Update prompt-builder.ts to emit placeholder tokens
- New packages/ai/src/discount-substitutor.ts pure module
- AI Worker calls substitutor AFTER LLM response, BEFORE Message.generatedText write
- Unit tests for substitutor + prompt builder

BATCH 4.2: Shopify discount creation + AiGeneration discount columns
- AiGeneration.discountCode + discountValuePercent + shopifyDiscountId columns + migration
- packages/shopify/src/discounts.ts with createWinbackDiscountCode
- AI Worker creates discount BEFORE building prompt; expiry = MerchantSettings.attributionDirectWindowDays
- AUDIT_ACTIONS.discount.created registered
- Unit + integration tests with mocked Shopify

BATCH 4.3: Expiry cleanup cron
- apps/scheduler/src/jobs/discount-cleanup.ts (daily 02:00 UTC)
- QUEUE_NAMES.discount.cleanup + AUDIT_ACTIONS.discount.expired registered
- Idempotent — 404 from Shopify is success
- Unit + integration tests

Per batch: surface ACTUAL FILES, await sign-off, commit, push only on explicit instruction.
```

---

## Section 5 — Time-bounded stale generation retry

### Why this exists

Epic F Q9 locks same-provider retry with exponential backoff up to 3 attempts. During a multi-hour provider outage, retries can stretch into the next day. Sending "we miss you, it's been a while" 24+ hours after the actual state transition is semantically broken — the message anchors to an event the customer experienced yesterday, not today.

### Batch plan

**Batch 5.1 (single batch):**

Code:
- AI Worker `processJob` top — after loading the `AiGeneration` row: if `Date.now() - row.createdAt.getTime() > 24 * 60 * 60 * 1000`, mark `status = failed`, `lastError = 'generation_stale'`, return. No LLM call. No spend bucket increment. Non-retryable in the BullMQ error classifier.
- Update `EPIC-F-DESIGN.md` edge cases table to add the staleness row.

Registry additions:
- None (`'generation_stale'` is a `lastError` string, not a registry constant — same pattern as `'content_filter'` and `'monthly_spend_cap_exceeded'`).

Test surface:
- Unit: row with `createdAt < 24h ago` proceeds normally.
- Unit: row with `createdAt > 24h ago` marked stale + skipped.
- Unit: BullMQ does NOT retry after staleness (verify via error classification).

### Claude Code prompt

```
Implement v1 Section 5: Time-bounded stale generation retry.

Context (read first):
- EPIC-F-DESIGN.md (Q9 retry policy + edge cases table)
- apps/drainer/src/workers/ai-generate.worker.ts
- POST-EPIC-F-CONSCIOUS-DECISION.md Section 5

Constraints:
- 24h hardcoded for v1; merchant-configurable later if needed
- 'generation_stale' is non-retryable — add to the isRetryable classifier's non-retryable list
- Update EPIC-F-DESIGN.md edge cases table in the same commit

Batch surface (one batch):
1. AI Worker staleness check at processJob top
2. Update isRetryable classifier
3. Update EPIC-F-DESIGN.md edge cases table
4. Unit tests

Surface ACTUAL FILES. Await sign-off.
```

---

## Section 6 — Path 3: M10 one-liner scope assertions

### Why this exists, why now

`POINTS-TO-CONSIDER.md` items C-5, M-1, S-5 are open M10 hardening tasks. Each is a 1-line scope assertion fix. Doing them BEFORE Epic G is cheaper because every new G repository / handler is another caller that would otherwise inherit the latent footgun. Path 3 in `handoff.md` framed these as "half-session"; this section makes that concrete.

### Batch plan

**Batch 6.1 (single batch, ~0.5 day):**

Code (all one-liners, one PR):
- `OutboxRepository.markProcessed / markFailed / markDeadLettered / markDeferredFailed` — add `const scope = getTenantScope(); if (scope?.kind !== 'system') throw new Error('mark-* requires system scope');` at the top. Mirrors `claimBatch`. (C-5)
- `MerchantRepository.hardDelete` — same assertion pattern. (M-1)
- Either register `web.shop_lookup` as a generic reason and update `/customers` + `/settings` loaders, OR register per-route reasons (`web.customers_lookup`, `web.settings_lookup`). Founder picks during audit. (S-5)

Registry additions:
- Per S-5 founder choice: either `SYSTEM_SCOPE_REASONS.web.shop_lookup` (single), or `web.customers_lookup` + `web.settings_lookup` (per-route).

Test surface:
- Unit: each mark-* method rejects tenant-scope calls.
- Unit: `hardDelete` rejects tenant-scope calls.
- Unit: `/customers` + `/settings` loaders use the chosen reason(s) — `tenant-scope.test.ts` regression lock.

### Claude Code prompt

```
Implement v1 Section 6 (Path 3): M10 one-liner scope assertions for C-5, M-1, S-5.

Context (read first):
- POINTS-TO-CONSIDER.md (entries C-5, M-1, S-5)
- packages/db/src/repositories/outbox.repository.ts
- packages/db/src/repositories/merchant.repository.ts
- apps/web/app/routes/customers.tsx + settings.tsx (or wherever the loaders live)
- POST-EPIC-F-CONSCIOUS-DECISION.md Section 6

Constraints:
- Each fix is a single-line scope assertion, mirroring OutboxRepository.claimBatch's existing pattern
- S-5 has a founder choice: ONE generic web.shop_lookup reason, OR per-route web.customers_lookup + web.settings_lookup. SURFACE BOTH OPTIONS, await founder choice
- All three fixes land in ONE commit (small, focused PR)
- POINTS-TO-CONSIDER.md updated in same commit marking C-5 / M-1 / S-5 resolved

Batch surface (one batch):
1. OutboxRepository mark-* methods get scope guard (4 method updates)
2. MerchantRepository.hardDelete gets scope guard
3. S-5: surface the two options, get founder choice, implement chosen reason(s) in @winback/contracts + loader updates
4. tenant-scope.test.ts regression locks
5. POINTS-TO-CONSIDER.md updated

Surface ACTUAL FILES + S-5 option presentation. Await sign-off.
```

---

## Section 7 — Path 2: Operator pre-launch (founder, not Claude)

### Tasks

Two tasks from `SHOPIFY-SCOPES-AUDIT.md`'s ⚠️ OUTSTANDING list:

1. **Production deploy env update.** `SHOPIFY_SCOPES` env var on production hosting (Vercel / Fly / etc.) updated to the 8-scope union string. The string is already in `.env.example` and `ci.yml` per commit `9220acb`.
2. **Partners Dashboard sync.** App config in Shopify Partners Dashboard updated to declare the same 8-scope union. Without this, install fails — Shopify rejects scope strings that don't match the declared union.

### When

Any time after Section 1 starts, before week 14 (design partner installs). ~1 hour total. Not blocking any code section — slot into the gaps.

### No Claude Code prompt

This is operator/founder work. Do it manually:
1. Open Vercel (or wherever) → environment variables → update `SHOPIFY_SCOPES` → redeploy.
2. Open Shopify Partners Dashboard → app → Configuration → update scope union → save.
3. Verify by running a fresh install on a test store — the consent screen should list all 8 scopes.
4. Update `SHOPIFY-SCOPES-AUDIT.md` clearing the ⚠️ OUTSTANDING marker. Commit as `chore: clear shopify scopes audit outstanding marker`.

---

## Section 8 — Epic G: Campaigns, segments, workflows, dispatch

### Scope locks for v1 (per V1–V10)

- Email + SMS channels only. NO WhatsApp.
- Discount code consumed from `AiGeneration` (created upstream in Section 4). Epic G does NOT create new discount codes.
- Marketing Activities API push required (we have `write_marketing_events`, native-in-Shopify-Admin feel is high-value).
- Per-merchant suppression list mandatory before any send.
- Workflow engine: up to 5 steps, linear only, no branching in v1.
- Send-time scheduling via `Merchant.timezone` + `MerchantSettings.sendTimeStartHour` / `EndHour`.

### Companion design doc

`EPIC-G-DESIGN.md` lands in batch 8.1 alongside the schema migration, matching the Epic E session 2 / Epic F batch 1 pattern. Treat this Section as scope-summary; the full contract lives in `EPIC-G-DESIGN.md` when written.

### Batch plan (9 batches)

| Batch | Scope |
|---|---|
| 8.1 | `EPIC-G-DESIGN.md` (full contract, Q-locks for workflow data model, dispatch architecture, suppression shape, quota enforcement, Marketing Activities integration, send-time scheduling) + schema (Segment, SegmentMembership, Suppression, Workflow, WorkflowExecution, WorkflowStepExecution, Campaign, CampaignTarget, MessageEvent, MessageQuotaBucket) + ALTER Message (add campaignId, workflowStepExecutionId, channel, sentAt, provider) + ALTER TYPE MessageStatus ADD VALUE (sent, suppressed, failed, bounced, opened, clicked) + cascade-policy header update + TENANT_SCOPED_MODELS additions |
| 8.2 | SendGrid email provider integration (`packages/email`?  or part of a new `packages/messaging` — locked in 8.1's design doc). Adapter interface mirroring `packages/ai`'s `AiProvider`. Mocked-SDK unit tests. |
| 8.3 | Twilio SMS provider integration. Same adapter pattern. STOP-reply handling for suppression. |
| 8.4 | Workflow engine — multi-step linear orchestration. WorkflowStepExecution drives the next step. BullMQ queue + worker. |
| 8.5 | Segment engine — RFM-band + tag-based + custom-field segments. SegmentMembership materialization (rebuild on customer write via outbox event, NOT scan-on-read at audience-build time). |
| 8.6 | Suppression list + quota enforcement. Per-merchant. `MessageQuotaBucket` uses the same `SELECT FOR UPDATE` pattern as `AiSpendBucket`. STOP / unsubscribe / bounce / spam-complaint all write Suppression rows. |
| 8.7 | Marketing Activities API push. Every campaign sends + outcomes report back to Shopify's marketing dashboard. |
| 8.8 | UI shell — campaign builder, workflow builder, segment editor, send-time settings. Polaris 13. |
| 8.9 | Integration tests (real Postgres + mocked providers) — full Customer → Segment → Campaign → Workflow → Dispatch → MessageEvent end-to-end. |

### Effort

6–8 weeks honestly. Each batch is 4–7 days, some less, some more. UI batch is its own discipline and may need to break into 8.8.1 / 8.8.2.

### Claude Code prompt (batch 8.1 only — gate before opening 8.2)

```
Implement v1 Section 8 Batch 8.1: Epic G design doc + schema.

Context (read first):
- ARCHITECTURE.md
- EPIC-F-DESIGN.md (the doc structure G follows)
- CP2-ATTRIBUTION-CONTRACT.md (G's MessageEvent rows are H1's input)
- packages/db/prisma/schema.prisma
- POINTS-TO-CONSIDER.md item #20 (Shopify Billing API before Epic G ships campaign sends)
- POST-EPIC-F-CONSCIOUS-DECISION.md Section 8 + locks V1, V2, V4

Constraints for Epic G v1:
- Email + SMS only. NO WhatsApp.
- Discount code consumed from AiGeneration, NOT created by G.
- Marketing Activities API push required.
- Suppression list mandatory before any send.
- Workflow engine: up to 5 linear steps, no branching.
- Send-time via Merchant.timezone + MerchantSettings.sendTimeStartHour / EndHour.

Batch 8.1 deliverables:
1. EPIC-G-DESIGN.md — full design doc with Q-locks
2. Schema additions: Segment, SegmentMembership, Suppression, Workflow, WorkflowExecution, WorkflowStepExecution, Campaign, CampaignTarget, MessageEvent, MessageQuotaBucket
3. ALTER Message: add campaignId, workflowStepExecutionId, channel, sentAt, provider columns
4. ALTER TYPE MessageStatus ADD VALUE (sent, suppressed, failed, bounced, opened, clicked)
5. Cascade policy header update
6. TENANT_SCOPED_MODELS additions in packages/db/src/tenant-scope.ts
7. Single auto-generated migration + hand-authored DDL for ALTER TYPE
8. EPIC-G-DESIGN.md committed in the same commit as the migration (design-doc-in-batch-1 pattern)

Do NOT begin batch 8.2 (SendGrid integration) until 8.1's design doc is reviewed AND approved.

Surface ACTUAL FILES. Await sign-off.
```

> Subsequent batches (8.2–8.9) get their own Claude Code prompts written from the locked EPIC-G-DESIGN.md surface table.

---

## Section 9 — Epic H1: Direct + Assisted attribution (PARALLEL with Epic G)

### Critical sequencing rule

**Begin Epic H1 in parallel with Epic G after batch 8.1 lands (i.e., after the schema is locked).** Do NOT wait for Epic G to finish. Sequential H1 after G means launching with `$0` on the dashboard — merchant-facing proof-of-value missing on day one of paid use.

### Scope locks for v1 (per V3)

- Direct AND Assisted both on the dashboard, labeled.
- Multi-message resolution: most recent message within window wins. (Confirm with CP-2; if CP-2 says otherwise, CP-2 wins.)
- Per-currency rollups captured correctly. Dashboard rendering is single-currency in v1.
- Refund handling: if an attributed order is refunded, mark `AttributionEvent.reversedAt = now()`. DO NOT delete the row (forensic survival).
- Dashboard reads from `MetricsDailyRollup`, not `AttributionEvent` (perf).

### Companion design doc

`EPIC-H1-DESIGN.md` lands in batch 9.1.

### Batch plan (5 batches)

| Batch | Scope |
|---|---|
| 9.1 | `EPIC-H1-DESIGN.md` + schema (AttributionEvent, AttributionWindow, MetricsDailyRollup, CustomerCurrencyTotal) + cascade-policy header update + TENANT_SCOPED_MODELS additions + CP-2 amendment process documented |
| 9.2 | Direct attribution matcher in drainer's order handler. Triggered on `orders/create`. Window = `MerchantSettings.attributionDirectWindowDays`. Writes `AttributionEvent` with `type = 'direct'`. |
| 9.3 | Assisted attribution matcher — same trigger, complementary logic. Window = `MerchantSettings.attributionAssistedWindowDays`. |
| 9.4 | Rollup extension to `cron.rollup` + dashboard widgets reading `MetricsDailyRollup`. Three numbers: directly attributed, assisted, total influence. Sparkline of daily attribution. |
| 9.5 | Refund reversal — `orders/updated` handler marks `AttributionEvent.reversedAt` when order moves to `refunded` / `partially_refunded`. Rollup re-computes affected days. Integration tests. |

### Effort

3–4 weeks. Smaller than Epic G but the matcher logic has subtle edge cases (multi-message resolution, refund reversal, multi-currency aggregation).

### Claude Code prompt (batch 9.1 only)

```
Implement v1 Section 9 Batch 9.1: Epic H1 design doc + schema.

Context (read first):
- CP2-ATTRIBUTION-CONTRACT.md (the entire approved contract)
- ARCHITECTURE.md
- EPIC-G-DESIGN.md (once 8.1 lands — H1 reads MessageEvent rows)
- MerchantSettings.attributionDirectWindowDays + attributionAssistedWindowDays (already in schema, defaults 14 + 30)
- POST-EPIC-F-CONSCIOUS-DECISION.md Section 9 + Lock V3

CRITICAL: H1 batch 9.1 can start IMMEDIATELY after Epic G batch 8.1 lands. Do NOT wait for Epic G to finish.

Constraints for Epic H1 v1:
- Direct AND Assisted both on dashboard
- Multi-message resolution: most recent message within window wins
- Per-currency rollups captured correctly; dashboard single-currency in v1
- Refund reversal via reversedAt column, not row deletion
- Dashboard reads from MetricsDailyRollup
- CP-2 amendment process documented as part of EPIC-H1-DESIGN.md

Batch 9.1 deliverables:
1. EPIC-H1-DESIGN.md — full design doc with Q-locks for matcher trigger surface (orders/create in drainer), multi-message resolution, per-currency aggregation, refund handling, dashboard read path, rollup cron extension, CP-2 amendment process
2. Schema: AttributionEvent, AttributionWindow, MetricsDailyRollup, CustomerCurrencyTotal
3. Index strategy for the matcher's hot query (customer + message events in window)
4. Cascade policy header update
5. TENANT_SCOPED_MODELS additions

Do NOT begin batch 9.2 (direct matcher) until 9.1 is reviewed AND approved.

Surface ACTUAL FILES. Await sign-off.
```

> Batches 9.2–9.5 get their own prompts written from the locked EPIC-H1-DESIGN.md.

---

## Section 10 — Shopify Billing API integration

### Founder-only blocker

Tier prices must be locked BEFORE this section opens. Recommended structure (per V5):

| Tier | Customer range | Price/mo (founder fills) | Trial |
|---|---|---|---|
| Starter | 0 – 5,000 | $TBD | 14 days |
| Growth | 5,001 – 25,000 | $TBD | 14 days |
| Scale | 25,001 – 100,000 | $TBD | 14 days |
| Custom | 100,001+ | Talk to us | — |

Market reference points for AI-driven retention apps targeting mid-size DTC: Starter $79–$149, Growth $199–$399, Scale $499–$1,499. Anchor pricing to perceived ROI ("recover $5K/mo for $99/mo" is an obvious yes), not to cost-plus-margin.

### Tier transition policy

- 90% of cap → in-app banner + email warning.
- 100% of cap → soft block (campaigns still send; banner intensifies; merchant prompted to upgrade).
- 110% of cap → hard block (campaigns paused until upgrade).

### Batch plan (4 batches)

| Batch | Scope |
|---|---|
| 10.1 | `apps/web/app/services/billing.service.ts` — GraphQL mutations for `appSubscriptionCreate / Cancel / LineItemUpdate`. `apps/web/app/routes/billing.subscribe.tsx` + `billing.callback.tsx` for the OAuth-style confirmation flow. |
| 10.2 | `app_subscriptions/update` webhook handler. Updates `BillingSubscription` row. New `AUDIT_ACTIONS.billing.*` entries. |
| 10.3 | Auto-tier-detection scheduler job. Weekly Customer count per merchant; banner / email on threshold breach. |
| 10.4 | UI: `/pricing` page (logged-out + logged-in views), in-app billing banner. Integration tests via Shopify dev mode (test charges). |

### Effort

~2 weeks. Can start mid-Epic-G, parallel with batches 8.5–8.9.

### Claude Code prompt (batch 10.1 only)

```
Implement v1 Section 10 Batch 10.1: Shopify Billing API subscription flow.

Context (read first):
- POINTS-TO-CONSIDER.md item #20
- packages/db/prisma/schema.prisma (BillingSubscription model — already exists)
- Shopify docs on Recurring Application Charges (appSubscriptionCreate GraphQL mutation)
- POST-EPIC-F-CONSCIOUS-DECISION.md Section 10 + Lock V5

Tier prices: FOUNDER FILLS BEFORE STARTING. Surface a stub config + ask for the three numbers.

Constraints:
- Use Shopify Billing API. NOT Stripe. NOT anything else.
- 14-day trial on all tiers
- Customer-count banding (NOT order volume, NOT send volume)
- BillingSubscription row already exists in schema — extend if needed but minimal additions
- Test all flows in Shopify dev mode with test charges before production code path

Batch 10.1 deliverables:
1. apps/web/app/services/billing.service.ts — appSubscriptionCreate / Cancel / LineItemUpdate mutations
2. apps/web/app/routes/billing.subscribe.tsx — initiates subscription, redirects to Shopify confirmation URL
3. apps/web/app/routes/billing.callback.tsx — handles post-approval redirect, updates BillingSubscription
4. AUDIT_ACTIONS.billing.subscription_created + .activated registered
5. Unit + integration tests with mocked Shopify Billing API responses

Do NOT begin batch 10.2 (webhook handler) until 10.1 is reviewed.

Surface ACTUAL FILES + ask for tier prices. Await sign-off.
```

---

## Section 11 — Pre-launch hardening pass

### Scope

`POINTS-TO-CONSIDER.md` Fix-Before-M10 items not yet resolved + new items from this review. Section 6 (Path 3 one-liners) already cleared C-5, M-1, S-5; this section handles the rest.

### Item register

| # | Item | Source | Effort |
|---|---|---|---|
| 11.1 | Per-shop webhook circuit breaker | This review | 2 days |
| 11.2 | Webhook subscription reconciliation cron (daily 03:00 UTC) | This review | 2 days |
| 11.3 | Webhook replay-attack defense (reject `X-Shopify-Triggered-At` > 5 min old) | This review | 0.5 day |
| 11.4 | GDPR data-export pipeline (the customers/data_request handler body) | POINTS-TO-CONSIDER #17 | 3 days |
| 11.5 | CI-1 drift-check fold into ci.yml | POINTS-TO-CONSIDER CI-1 | 0.5 day |
| 11.6 | CONTRIBUTING.md | POINTS-TO-CONSIDER #13 | 1 day |
| 11.7 | commitlint + husky | POINTS-TO-CONSIDER #14 | 0.5 day |
| 11.8 | Webhook ingest rate limiting (separate from 11.1's circuit breaker — this is global) | POINTS-TO-CONSIDER #15 | 1 day |
| 11.9 | Shopify Admin API version bump cadence documented in CONTRIBUTING.md | This review | 0.5 day (rolls into 11.6) |
| 11.10 | Polaris 13 → 14 migration audit (time-box 2 hours; migrate or document staying) | This review | 0.5 day |
| 11.11 | `AiGeneration.generatedText` immutability post-completion (CHECK or repository chokepoint) | This review | 0.5 day |
| 11.12 | Prisma 5.22 upgrade plan documented (no actual upgrade in v1) | POINTS-TO-CONSIDER #10 | 0.5 day |

Each item is its own commit (or small group). Sequence flexible — work top-to-bottom unless an item blocks another. 11.1 + 11.3 are the highest-impact (webhook flood + replay attack defenses).

### Claude Code prompt (open per-item)

Each item gets its own focused prompt. No master prompt — bundling these is the anti-pattern. Example for 11.1:

```
Implement v1 Section 11 Item 11.1: Per-shop webhook circuit breaker.

Context (read first):
- POINTS-TO-CONSIDER.md item #15
- apps/web/app/routes/webhooks.tsx (the ingest endpoint)
- packages/queue (Redis client)
- POST-EPIC-F-CONSCIOUS-DECISION.md Section 11

Constraints:
- Redis-backed per-shop counter, keyed (shop, current_minute_bucket)
- Threshold: N webhooks/minute for K consecutive minutes → penalty for M minutes
- N, K, M operator-tunable via env (defaults safe for normal merchant load)
- During penalty: return HTTP 200 + log status='skipped_circuit_breaker' WITHOUT enqueueing outbox
- WebhookLog rows tagged for operator visibility

Batch surface (one batch):
1. apps/web/app/middleware/circuit-breaker.ts (or wherever this fits)
2. WebhookProcessingStatus enum add 'skipped_circuit_breaker' (ALTER TYPE migration)
3. Env config additions
4. Unit + integration tests (simulated burst exceeding threshold)

Surface ACTUAL FILES. Await sign-off.
```

> Repeat for each item 11.2–11.12.

---

## Section 12 — App Store listing prep

### Founder-only deliverables

- App icon (1200×1200 PNG, designed)
- 5–8 listing screenshots with one-line captions
- 90-second demo video
- App description (~500 words; lead with "win back lapsed customers with AI-generated personalized messaging + provable recovered-revenue attribution; addresses 'why this and not Klaviyo's win-back flow'")
- Pricing description (mirrors Section 10 tiers)
- Support email + 4-business-hour reply SLA
- Privacy policy + Terms of Service (generator → lawyer eyeball)
- GDPR compliance statement (data handling, subprocessors: LLM provider + SendGrid + Twilio + Shopify, retention policy)

Block 3 days at week 13 for these. They are NOT Claude Code tasks.

### Claude-doable subset

| Batch | Scope |
|---|---|
| 12.1 | Demo store seed script `scripts/seed-demo-store.ts` (500 customers across state bands, 2K orders over 18mo, 50 AiGenerations + Messages, 10 AttributionEvents). Realistic dashboard numbers for reviewers. |
| 12.2 | `/legal/privacy` + `/legal/terms` routes (content from founder-provided generator output, lawyer-reviewed). |
| 12.3 | `/support` page with contact form / mailto. |
| 12.4 | Marketing site routes: `/`, `/pricing`, `/features`, `/about`. Polaris-styled-but-NOT-using-Polaris (Polaris is embedded-admin only). |
| 12.5 | `/sitemap.xml` + `/robots.txt`. |

### Claude Code prompt (batch 12.1 only)

```
Implement v1 Section 12 Batch 12.1: Demo store seed script.

Context (read first):
- packages/db/prisma/schema.prisma
- POST-EPIC-F-CONSCIOUS-DECISION.md Section 12

Constraints:
- Idempotent — re-running on the same dev store does NOT duplicate rows (uses fixed cuid prefixes or upsert)
- Realistic distributions: state bands match real RFM curves (not flat across all customers), order spread over 18 months, AttributionEvents producing recovered revenue in the $5K-15K range
- Tenant-scoped throughout — runs against one specific merchant row
- Does NOT call Shopify API — pure local DB seeding

Batch surface (one batch):
1. scripts/seed-demo-store.ts
2. pnpm script entry: pnpm cli:seed:demo
3. README section explaining how to use it for App Store review

Surface ACTUAL FILES. Await sign-off.
```

> Batches 12.2–12.5 get their own prompts.

---

## Timeline summary

| Weeks | Work |
|---|---|
| 0 (now) | Epic F batches 2–5 finish |
| 1 | Sections 1, 2, 3, 5 (bundle as one ~4-day batch or sequenced — founder picks) + start design partner outreach |
| 2 | Section 4 batches 4.1–4.3 + design partner outreach continues |
| 3 | Section 6 (Path 3 one-liners) + Section 7 (Path 2 operator tasks, 1 hour) |
| 4–5 | Section 8 batch 8.1 (Epic G design doc + schema) + Section 9 batch 9.1 (Epic H1 design doc + schema) in parallel |
| 6–11 | Section 8 batches 8.2–8.9 (Epic G implementation) + Section 9 batches 9.2–9.5 (Epic H1 implementation) interleaved |
| 8–10 | Section 10 batches 10.1–10.4 (Billing API), starts mid-Epic-G |
| 12–13 | Section 11 (hardening pass) |
| 13–14 | Section 12 (App Store listing prep, founder + Claude-doable) |
| 14 | Submit to Shopify App Store |
| 14–18 | Shopify review cycle, budget one rejection + resubmit |
| 16–18 | Design partner beta (3–5 merchants live) |
| 18+ | First paying merchant |

**~18 weeks = ~4.5 months.** The unknown is Shopify review. Some apps approve in 5 days; some take three rounds.

---

## Reading the doc going forward

1. After Epic F batches 2–5 close (and `handoff.md` is updated), re-read this doc top-to-bottom once for orientation.
2. Open Section 1. Read the lock, the batch plan, the prompt block. Surface the prompt to Claude Code.
3. Per-batch audit-gate: surface files, audit, sign off, commit, push only on instruction.
4. Update this doc in the same commit as any work that closes a section (mark the section ✅ resolved with the SHA).
5. When Claude Code proposes adding rigor (a new contract, a new lock, a new registry) that's not in this doc, pause and ask: does this move closer to first paying merchant? If no, defer to v1.1. The platform-quality bar is already met; the feature surface is allowed to be sloppy.

---

## Working agreement (inherited from handoff.md, non-negotiable)

- Never `git commit` without explicit founder sign-off on the delivery.
- Never `git push` without explicit founder instruction.
- Per-batch audit gate for every multi-batch section.
- Numbered-option resolution when surfacing founder choices.
- Summaries ≤ 30 lines default; multi-file batch surfaces may exceed.
- Point at design docs instead of restating decisions in chat.
- "Read the files, grep the repo" for gap analysis. No guessing.
- External HTTP calls NEVER inside `prisma.$transaction`.
- No real LLM calls in CI — mocked in unit + integration tests.

---

## Resolution log

Mark each section ✅ when its last batch merges. Use the SHA. Example:
- Section 1 ✅ `<sha>` (2026-MM-DD)
- Section 4 ✅ batches 4.1 `<sha>`, 4.2 `<sha>`, 4.3 `<sha>`

(Currently empty — no section resolved.)

---

*Source of truth for the v1 launch arc. Update in the same commit as any work that affects scope, channel, attribution, pricing, or launch sequencing.*
