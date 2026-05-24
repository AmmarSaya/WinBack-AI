# Epic F — AI Message Generation

**Status:** DRAFT — awaiting senior review approval before any schema or code is written.
**Scope:** Multi-provider LLM call site + prompt construction + `AiGeneration` table + minimal `Message` table (Epic G extends) + `AiSpendBucket` table + per-merchant cost ceiling enforcement. Triggered by `customer.state_changed` outbox events in the drainer.
**Companion docs:** [ARCHITECTURE.md](ARCHITECTURE.md), [CP2-ATTRIBUTION-CONTRACT.md](CP2-ATTRIBUTION-CONTRACT.md), [EPIC-E-SESSION-2-DESIGN.md](EPIC-E-SESSION-2-DESIGN.md), [SHOPIFY-SCOPES-AUDIT.md](SHOPIFY-SCOPES-AUDIT.md), [POST-EPIC-E-AUDIT.md](POST-EPIC-E-AUDIT.md).
**Schema reference:** `packages/db/prisma/schema.prisma` at `main` SHA `9220acb`.

This document is a permanent contract. Any future change to the generation pipeline, provider abstraction, cost tracking, Message storage, or prompt construction MUST update this file in the same commit.

---

## Locked design decisions (read first)

| Q | Lock | Source |
|---|---|---|
| Q1 — Provider model | **Platform-managed multi-provider. DeepSeek, OpenAI, Anthropic supported. Active provider is a platform config (`AI_PROVIDER` env), not per-merchant. Adapter interface isolates SDK-specific code; switching providers is a config change, not code.** | Session-start |
| Q2 — Billing model | **Platform key, fixed monthly tiers via Shopify Recurring Application Charges (NOT Usage Billing). Platform absorbs LLM cost; `AiSpendBucket` tracks platform spend per merchant per day for margin observability + cap enforcement.** | Session-start |
| Q3 — Generation surface | **Queued — drainer emits `ai.generate` BullMQ job; separate AI Worker calls LLM + writes both `AiGeneration` and `Message` rows. NOT inline in drainer tx. Backpressure controlled at the BullMQ queue.** | Session-start |
| Q4 — Trigger | **Drainer's `customer.state_changed` handler enqueues `ai.generate` when `newState ∈ {at_risk, dormant, lost}` and `oldState !== newState`. "Just-in-time" means at the campaign-decision moment (state transition), NOT at the send moment. Epic G's dispatch worker reads existing draft `Message` rows; G does NOT trigger generation.** | Session-start lock Q3 + followup Q1 reconciliation |
| Q5 — Cost tracking | **`AiSpendBucket` daily granularity (one row per `(merchantId, date)`). `MerchantSettings.monthlyAiSpendCapCents` is the ceiling; pre-call check sums the current month's daily buckets. Hard stop at cap — generations rejected with `AiGeneration.status = failed`, `lastError = 'monthly_spend_cap_exceeded'`. No retry.** | Session-start + doc-design Q3 + Q4 |
| Q6 — Tone | **`MerchantSettings.aiTone` (already in schema, locked structural shape via Zod `aiToneSchema` at write time per T5) is merged into every system prompt. No per-generation tone override v1.** | Schema header T5 + session-start |
| Q7 — Message ownership | **F's AI Worker writes BOTH `AiGeneration` AND `Message` rows in one tx. Atomicity + clean ownership. `Message.status = 'draft'` until Epic G's dispatch worker transitions it. The `Message` table ships with minimal columns in F batch 1; G's batch 1 adds `Campaign` / `WorkflowStepExecution` FK columns + extends `MessageStatus` enum.** | Doc-design Q2 |
| Q8 — Prompt templates | **Hybrid. Hardcoded templates in `packages/ai` for v1 (~5 templates: one per actionable state band). Table-backed surface (`PromptTemplate` table, merchant-editable) deferred to a later F session or Epic G when the catalog needs to grow.** | Doc-design Q5 |
| Q9 — Provider failover | **Same-provider retry only. Exponential backoff for 429 / 503; abort on content-policy-block (non-retryable). Cross-provider failover deferred to M10 (different model output styles need separate prompt tuning).** | Session-start light proposal |
| Q10 — Content safety | **Provider built-in moderation only (OpenAI's moderation endpoint and Anthropic's built-in filters are first-pass). No separate moderation API call in F v1. Human review queue (merchant approves before send) lands in Epic G.** | Session-start light proposal |

---

## Policy decisions

### F-1 — Provider abstraction layer

A thin adapter interface isolates every LLM provider behind a common contract. The AI Worker calls the interface; it never calls a provider SDK directly.

```typescript
interface AiProvider {
  readonly name: 'deepseek' | 'openai' | 'anthropic';
  generate(args: AiGenerateArgs): Promise<AiGenerateResult>;
}

interface AiGenerateArgs {
  model: string;                 // e.g. 'gpt-4o', 'claude-sonnet-4-6', 'deepseek-chat'
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
}

interface AiGenerateResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
}
```

Three concrete implementations: `OpenAiProvider`, `AnthropicProvider`, `DeepSeekProvider`. All live in a new `packages/ai` package (see F-2). Switching providers is a single env-var change (`AI_PROVIDER=deepseek | openai | anthropic`) — no code change, no migration.

**Provider errors are typed:**
- `AiProviderRateLimitError` (429) — retryable; BullMQ retries with exponential backoff up to 3 attempts.
- `AiProviderTransientError` (503, network) — same retry policy.
- `AiProviderContentBlockedError` — non-retryable; `AiGeneration.status = failed`, `lastError = 'content_filter'`.
- `AiProviderAuthError` (401) — non-retryable; operator alert (provider API key wrong/expired).
- `AiProviderInvalidRequestError` (400) — non-retryable; usually a prompt-construction bug, log + fail.

### F-2 — Package placement: `packages/ai`

New workspace package. Exports:
- `AiProvider` interface + the three concrete implementations
- `buildWinbackPrompt(args): { systemPrompt, userPrompt }` — pure function, no I/O
- `PROVIDER_COST_RATES` — per-provider, per-model cost rates in microcents per token
- `estimateCostMicrocents(provider, model, inputTokens, outputTokens): bigint`
- `selectActiveProvider(config): AiProvider` — reads `AI_PROVIDER` env, returns the singleton instance

`packages/ai` depends on `@winback/contracts` (for typed constants) but NOT on `@winback/db`. Cost-rate tables are pure data; DB writes happen in the AI Worker in `apps/drainer`. Reason: same data-flow direction discipline as rule #21 (Epic E session 1's Path X lesson).

### F-3 — Trigger surface: which state transitions generate a message

The `customer.state_changed` drainer handler currently routes to `handleNoop`. Epic F replaces that noop with `handleCustomerStateChanged`.

**Generates a message:**
- `newState` ∈ `{ at_risk, dormant, lost }` AND `oldState !== newState`

**Does NOT generate:**
- `newState` ∈ `{ active, warm, insufficient_data }` — not winback targets.
- Any transition where `oldState === newState` (impossible given the Epic E session 2 outbox producer gates on `stateChanged`, but the handler double-checks defensively).
- Customer whose `BillingSubscription.status` is NOT `active` or `trialing` — merchant hasn't paid, we don't spend on generation.
- Customer whose `Customer.deletedAt` IS NOT NULL (soft-deleted) — Customer findUnique returns null via the extension's soft-delete filter, handler logs + returns.

**One message per state-change event.** If a customer oscillates `at_risk → active → at_risk`, each `at_risk` entry generates a fresh `AiGeneration` + `Message`. Suppression logic (Epic G) prevents re-sending the same message class within a cooldown window; F's job is only generation, not send-gating. Cancelled drafts cost the LLM call but the marginal cost per draft is small ($0.001–$0.01 at DeepSeek rates).

### F-4 — `AiGeneration` table

One row per LLM call. Records the request, response, cost, and context. Never mutated after `completedAt` (append-only post-completion).

```prisma
model AiGeneration {
  id         String   @id @default(cuid())
  merchantId String
  merchant   Merchant @relation(fields: [merchantId], references: [id], onDelete: Cascade)

  customerId String
  customer   Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)

  // Trigger context — snapshot at generation time.  Future RFM
  // recomputes do NOT retroactively update these fields.
  triggerState   String  // CustomerStateValue — the newState that triggered this
  previousState  String  // CustomerStateValue — oldState for context
  rDays          Int
  fCount         Int
  mCents         BigInt
  currency       String  @db.Char(3)
  churnRiskScore Float?

  // Provider + model locked at generation time for forensics + cost reconciliation.
  // NOT a FK — provider config is platform env, not a DB entity.
  provider  String  // 'deepseek' | 'openai' | 'anthropic'
  modelId   String  // e.g. 'gpt-4o', 'claude-sonnet-4-6', 'deepseek-chat'

  // Prompts stored for auditability + prompt regression testing.
  systemPrompt  String  @db.Text
  userPrompt    String  @db.Text

  // LLM response.  Null until status = completed.
  generatedText String? @db.Text
  inputTokens   Int?
  outputTokens  Int?
  totalTokens   Int?
  latencyMs     Int?

  // Cost in microcents (billionths of a dollar) — BigInt for precision.
  // 1 USD = 100 cents = 100_000_000 microcents.  Microcents (not cents)
  // because modern LLM pricing is in fractions of a cent per token.
  // Stored as microcents to stay integer-safe throughout; converted to
  // cents only at the AiSpendBucket rollup layer.  Null until completed.
  costMicrocents BigInt?

  status    AiGenerationStatus @default(pending)
  failedAt  DateTime?
  lastError String?

  createdAt   DateTime  @default(now())
  completedAt DateTime?

  // Relation to the Message row F writes for this generation (Q7 lock).
  // 1:1 — every AiGeneration has at most one Message.  Message.aiGenerationId
  // is the @unique field on the other side.
  message Message?

  @@index([merchantId, createdAt])
  @@index([merchantId, customerId])
  @@index([status, createdAt])  // AI Worker retry scan
}

enum AiGenerationStatus {
  pending
  completed
  failed
}
```

**Cascade policy:** `Merchant → AiGeneration: CASCADE`. `Customer → AiGeneration: CASCADE` — generated text referencing customer PII is deleted with the customer (GDPR redact propagates).

**`costMicrocents` is BigInt.** LLM pricing is in fractions of a cent — DeepSeek-chat at $0.14/M input tokens = 140 microcents per 1000 tokens. Storing as integer microcents (BigInt) avoids float rounding on aggregation. Rule #19 (BigInt JSON boundary) applies: `.toString()` at every serialisation point.

### F-5 — `Message` table + `MessageStatus` enum (minimal F-batch-1 schema, Epic G extends)

Per Q7 lock, F's AI Worker writes BOTH `AiGeneration` AND `Message` in one tx. F batch 1 ships the minimum `Message` columns needed for the AI Worker to write the row. Epic G's batch 1 adds `Campaign` + `WorkflowStepExecution` FK columns + extends the `MessageStatus` enum via `ALTER TYPE ADD VALUE`.

```prisma
model Message {
  id         String   @id @default(cuid())
  merchantId String
  merchant   Merchant @relation(fields: [merchantId], references: [id], onDelete: Cascade)

  customerId String
  customer   Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)

  // 1:1 with AiGeneration — every Message originates from one LLM call.
  // @unique gives the relation parser the field-level unique it needs
  // for 1:1; same pattern as CustomerScore.customerId @unique in Epic E
  // session 2 (cuid is globally unique, single-column @unique is
  // sufficient + matches the established convention).
  aiGenerationId String       @unique
  aiGeneration   AiGeneration @relation(fields: [aiGenerationId], references: [id], onDelete: Cascade)

  // Denormalised for fast read at send time — G's dispatch worker reads
  // this without joining back to AiGeneration.  Mirrors the design-doc
  // pattern of snapshotting content at write-side for forensic survival
  // (same rationale as CP-2 §Q3's denormalised `messageSentAt`).
  generatedText String @db.Text

  status MessageStatus @default(draft)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // Epic G's batch 1 migration adds:
  //   campaignId String?
  //   campaign   Campaign? @relation(fields: [campaignId], references: [id], onDelete: SetNull)
  //   workflowStepExecutionId String?
  //   workflowStepExecution   WorkflowStepExecution? @relation(fields: [workflowStepExecutionId], references: [id], onDelete: SetNull)
  //   channel    MessageChannel  // enum: email, sms, whatsapp
  //   sentAt     DateTime?
  //   provider   String?         // SendGrid, Twilio, etc.
  // Documented here so F-batch-1 reviewers see the planned shape.

  @@index([merchantId, status])
  @@index([merchantId, customerId])
  @@index([merchantId, createdAt])
}

enum MessageStatus {
  draft
  // Epic G's batch 1 extends via ALTER TYPE ADD VALUE:
  //   sent, suppressed, failed, bounced, opened, clicked
  // Postgres enum extension is non-breaking (same pattern Epic E used
  // to add `insufficient_data` to `CustomerState` in session 2).
}
```

**Cascade chain:**
- `Merchant → Message: CASCADE` — tenant deletion removes Messages
- `Customer → Message: CASCADE` — GDPR customer redact removes Messages
- `AiGeneration → Message: CASCADE` — generation deletion removes its Message (also covers the GDPR redact path transitively: `Customer → AiGeneration: CASCADE → Message: CASCADE`)

The third cascade is the GDPR-critical link. Customer redact fires `Customer → AiGeneration: CASCADE`, which then cascades to `Message`. Postgres handles the chain atomically — generated text containing customer PII is gone in one DELETE.

**`Message` added to `TENANT_SCOPED_MODELS`.** `packages/db/src/tenant-scope.ts` — F batch 1 adds `'Message'` to the set. Same pattern as Epic E session 2 batch 4 added `'CustomerScore'`. Without this, the Prisma extension's read + write hooks pass-through Message operations without tenant injection or assertion — tenant-safety bug.

### F-6 — `AiSpendBucket` table

Accumulates per-merchant LLM spend per day (Q5 lock). Used to enforce `MerchantSettings.monthlyAiSpendCapCents`.

```prisma
model AiSpendBucket {
  id         String   @id @default(cuid())
  merchantId String
  merchant   Merchant @relation(fields: [merchantId], references: [id], onDelete: Cascade)

  // Day in UTC.  Stored as UTC midnight (e.g. 2026-06-15T00:00:00Z for
  // June 15 2026 UTC).  Merchant timezone is NOT used for bucket period
  // — the cap is calendar-month UTC, the daily-bucket key is UTC date.
  // Operator merchant-local rollup dashboards convert at read time.
  date DateTime

  // Running total in microcents for this day.  Incremented atomically
  // (SELECT FOR UPDATE on this row) when each AiGeneration completes.
  spentMicrocents BigInt @default(0)

  // Generation count for this day — denormalised for cheap
  // "generations per merchant per day" observability without an
  // AiGeneration COUNT(*) scan.
  generationCount Int @default(0)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([merchantId, date])
  @@index([merchantId, date])
}
```

**Ceiling enforcement — pre-call check:**

Before the LLM call, the AI Worker:
1. Computes `monthStart` = first UTC day of the current month.
2. Sums `spentMicrocents` across all `AiSpendBucket` rows where `merchantId = $1 AND date >= $monthStart`.
3. Computes estimated call cost: `estimateCostMicrocents(provider, model, estimatedInputTokens, estimatedOutputTokens)`. Output tokens estimated as `AI_MAX_TOKENS` (worst case) for the ceiling check.
4. If `currentMonthSpent + estimatedCallCost > monthlyAiSpendCapCents * 100_000` (cents → microcents), the generation is rejected: `AiGeneration.status = failed`, `lastError = 'monthly_spend_cap_exceeded'`. No LLM call. No BullMQ retry.

**Atomic increment — post-call:**

After a successful LLM call, the Worker updates today's `AiSpendBucket` row via a single Postgres `INSERT ... ON CONFLICT DO UPDATE` (Prisma's `upsert`):
1. `INSERT (merchantId, date, spentMicrocents = $delta, generationCount = 1)`.
2. `ON CONFLICT (merchantId, date) DO UPDATE SET spentMicrocents = spentMicrocents + $delta, generationCount = generationCount + 1`. The UPDATE path acquires the row-level X-lock on the `@@unique([merchantId, date])` index — the same lock a `SELECT FOR UPDATE` would acquire, folded into one round-trip instead of three.
3. Commits in the same tx as the `AiGeneration.markCompleted` write.

The unique-index row lock serializes concurrent increments from the same merchant's parallel generation jobs. Same race-prevention pattern Epic G will use for `MessageQuotaBucket`.

(Originally specified as a separate `SELECT FOR UPDATE` + `UPDATE` pair; corrected during batch 3 audit when the upsert variant landed in `AiSpendBucketRepository.incrementSpend` with the same atomicity guarantee and lower round-trip cost. See `packages/db/src/repositories/ai-spend-bucket.repository.ts` header for the decision-history paragraph.)

**Cascade policy:** `Merchant → AiSpendBucket: CASCADE`. Spend history deleted with the merchant. No GDPR concern — spend data is platform-internal accounting, not merchant-visible PII.

### F-7 — Prompt construction

`buildWinbackPrompt` is a pure function in `packages/ai`. Tested as a pure function — no LLM call, no DB.

```typescript
interface WinbackPromptArgs {
  customer: {
    firstName: string | null;
    lastName: string | null;
    rDays: number;
    fCount: number;
    mCents: bigint;
    currency: string;
    triggerState: CustomerStateValue;
    previousState: CustomerStateValue;
  };
  merchant: {
    name: string | null;
    shopCurrency: string;
    aiTone: AiTone | null;  // MerchantSettings.aiTone
  };
  recentProducts: RecentProduct[];      // last 3 products from read_products
  priceRules: ActivePriceRule[];        // from read_price_rules
}
```

Output: `{ systemPrompt: string, userPrompt: string }`.

**System prompt responsibilities:**
- Establish the AI as a customer winback specialist for the merchant
- Inject `MerchantSettings.aiTone` (style, avoid list, emphasize list, emoji policy, brand voice sample, custom instructions)
- Set hard constraints: no fake urgency, no invented facts, no medical/financial claims, max 3 sentences for SMS-class / 150 words for email-class, no competitor mentions

**User prompt responsibilities:**
- Customer context: first name (or "valued customer"), state band, days since last order, spend summary in merchant currency
- Product context: "Their last purchase included: {product titles}"
- Discount context: "Available for this customer: {discount summary}" (only if a relevant price rule exists)
- Explicit ask: "Write a {at_risk / dormant / lost}-appropriate winback message"

**Test surface in `packages/ai/tests/build-winback-prompt.test.ts`:** tone injection, null firstName fallback, state-appropriate framing, empty products list, no price rules, brand voice sample present vs absent, emoji policy `none` vs `liberal`, customer with zero orders (lurker, although triggers only fire on state transitions away from `active`/`insufficient_data` so this is defensive).

### F-7.5 — Discount placeholder tokens (Lock V9)

Pulled forward from `POST-EPIC-F-CONSCIOUS-DECISION.md` Lock V9 into Epic F batch 2 — the prompt builder is the natural home, and writing it twice (once token-free in F, once token-aware after V9 lands) is waste. The substitutor + Shopify discount creation + cleanup cron stay in Section 4 of the post-Epic-F arc; batch 2 ships only the prompt-side instruction.

**The rule.** AI never writes a raw discount code or percentage. The prompt instructs the LLM to emit two literal placeholder tokens — `{{DISCOUNT_CODE}}` and `{{DISCOUNT_VALUE_PERCENT}}` — wherever a discount needs to be referenced. A deterministic post-processor (Section 4 batch 4.1) substitutes the real values from the Shopify-created discount row at send time.

**`WinbackPromptArgs` extension.** The interface gains:

```typescript
discount: { code: string; valuePercent: number } | null;
```

Caller passes `null` when no discount is being offered. The prompt-builder branches on it:

- `discount === null` → the entire discount-context section is omitted from BOTH the system prompt and the user prompt. The LLM gets NO instruction about discounts at all, eliminating any chance of it inventing one.
- `discount !== null` → the system prompt includes a V9 instruction block ("Reference the code by writing EXACTLY this placeholder token..."), and the user prompt's discount-context section uses the literal placeholder strings. The `code` and `valuePercent` values themselves are NEVER rendered into either prompt — they flow through to `AiGeneration` storage (Section 4 batch 4.2 schema addition) but the LLM only sees the placeholders.

**What batch 2 prompt-builder does NOT own:**

- Shopify discount creation — Section 4 batch 4.2 (`packages/shopify/src/discounts.ts`, AI Worker creates discount before building prompt).
- Substitution of real values into `Message.generatedText` — Section 4 batch 4.1 (`packages/ai/src/discount-substitutor.ts`, AI Worker calls after the LLM response and before the Message write).
- Expiry cleanup cron — Section 4 batch 4.3.
- `AiGeneration.discountCode` + `AiGeneration.discountValuePercent` + `AiGeneration.shopifyDiscountId` columns — Section 4 batch 4.2 migration.

**Test surface additions in `build-winback-prompt.test.ts`:**

- `discount === null` → neither prompt contains the V9 tokens or "Discount" sections.
- `discount` provided → both placeholder tokens appear in the user prompt, exactly once.
- `discount` provided → the real `code` and `valuePercent` values do NOT appear anywhere in either prompt (V9 invariant).
- `discount` + `emojiPolicy === 'none'` → tokens still emit cleanly with no style-config leakage.

### F-8 — AI Worker: BullMQ job structure

New queue: `QUEUE_NAMES.ai.generate` (registered in `@winback/contracts/src/queue-names.ts`). Job payload:

```typescript
interface AiGenerateJobPayload {
  aiGenerationId: string;   // AiGeneration row pre-created at job-enqueue time
  merchantId: string;
  customerId: string;
}
```

The `AiGeneration` row is written to the DB by the `customer.state_changed` drainer handler BEFORE the BullMQ job is enqueued. Status is `pending`. The BullMQ job ID is the `aiGenerationId`. This ensures:

1. There is always a DB record of every generation attempt, even if the worker never starts.
2. The worker reads the generation row on pickup — if it finds `status !== 'pending'`, it no-ops (idempotent replay).
3. On hard failure (provider outage, content filter, spend ceiling), the worker updates `status: failed` + `lastError`. The job does NOT retry for content-filter failures or spend-ceiling rejections.
4. Provider 429 / 503 → BullMQ delay-retry with exponential backoff, up to 3 attempts.

**Worker process:** The AI Worker runs as a SECOND BullMQ Worker inside `apps/drainer` (same process, separate `Worker` instance on the `ai.generate` queue). Does NOT live in `apps/scheduler` — generation is event-driven, not time-driven.

**Per-merchant concurrency = 1** initially (BullMQ `groupLimit`-style). One generation job per merchant at a time prevents burst rate-limit consumption on Shopify's leaky-bucket Admin API (which the prompt-context-reads use for `read_products` + `read_price_rules`).

### F-9 — `customer.state_changed` handler rewrite

Current: `handleNoop(row)`.

Epic F replaces with `handleCustomerStateChanged(ctx, row)`:

```
1. Parse the customer.state_changed payload via the existing Q6 Zod schema.
2. Validate newState ∈ {at_risk, dormant, lost}.  If not → return (no-op).
3. Validate oldState !== newState.  Defensive — producer already gates on this.
4. Read Merchant + BillingSubscription:
   a. If BillingSubscription.status NOT in {active, trialing} → log + return.
5. Pre-flight spend ceiling check (F-6).  If exceeded → log + return WITHOUT
   creating an AiGeneration row.  Cheap denial before any DB write.
6. Read customer context outside the DB tx:
   a. Customer (already in DB — direct findUnique under tenant scope).
   b. Recent products (last 3 paid orders' line items → product titles).
   c. Active price rules (Shopify Admin GraphQL — `read_price_rules` scope).
   These are EXTERNAL HTTP reads (Shopify Admin API).  Must run OUTSIDE
   any prisma.$transaction (locked rule: never hold a Postgres tx open
   across an external HTTP call).
7. Build prompt via buildWinbackPrompt (pure function).
8. Open withTenantScope(merchantId) + prisma.$transaction.  Inside the tx:
   a. Write AiGeneration row with status=pending.
   b. Write Message row with status=draft, aiGenerationId = the just-created
      generation, generatedText = "" (empty — Worker fills it on completion).
   c. Commit.
9. Enqueue ai.generate BullMQ job with { aiGenerationId, merchantId, customerId }.
10. Return.  The handler does not wait for the LLM response.
```

The handler creates both `AiGeneration` AND `Message` rows in the same tx (Q7 lock). The Worker later mutates them — sets `AiGeneration.generatedText / inputTokens / outputTokens / costMicrocents / status=completed` AND sets `Message.generatedText = AiGeneration.generatedText` (denormalised copy for G's fast read).

**Why two writes in one tx vs Worker creating both?**
- Forensic record: even if the Worker process dies, both rows exist for operator investigation.
- The Worker's job is to FILL IN the generated text + cost; it doesn't have to manage row creation, just mutation.
- Race-free: G's dispatch worker scanning `Message WHERE status = 'draft'` always sees rows that have a corresponding AiGeneration to FK-join (no half-written state).

**Shopify API rate limiting:** The handler uses the existing `@winback/shopify` Admin GraphQL client, which respects Shopify's leaky-bucket rate limits. Per-merchant BullMQ concurrency = 1 (F-8) prevents the handler from running multiple parallel Shopify reads for the same merchant.

### F-10 — Cost rate table

Stored in `packages/ai/src/cost-rates.ts`. Operator updates the const when providers change pricing — no DB migration needed. Hardcoded for v1 (Q9 light lock); operator-editable table deferred to M10 if pricing churn outpaces PR cadence.

**Verified against vendor pricing pages 2026-05-21** (see also the file header in `cost-rates.ts` for the exact URLs and the quarterly re-verification cadence).

```typescript
// Microcents per 1M tokens (input / output separately).
// 1 USD = 100_000_000 microcents.  $5 per 1M tokens = 500_000_000 microcents.
//
// 8 entries — only the models we would ship to a paying merchant in the
// next 90 days. Legacy entries are NOT kept as "supported defaults" — they
// become attractive footguns the moment an operator's typo lands on one.
// See cost-rates.ts header for the full exclusion register.
export const PROVIDER_COST_RATES: Record<AiProviderName, Record<string, ModelCostRate>> = {
  openai: {
    'gpt-4.1':      { inputPer1M: 500_000_000n, outputPer1M: 1_500_000_000n }, // $5    / $15
    'gpt-4.1-mini': { inputPer1M:  40_000_000n, outputPer1M:   160_000_000n }, // $0.40 / $1.60
    'gpt-4.1-nano': { inputPer1M:  10_000_000n, outputPer1M:    40_000_000n }, // $0.10 / $0.40
  },
  anthropic: {
    'claude-opus-4-7':   { inputPer1M: 500_000_000n, outputPer1M: 2_500_000_000n }, // $5 / $25
    'claude-sonnet-4-6': { inputPer1M: 300_000_000n, outputPer1M: 1_500_000_000n }, // $3 / $15
    'claude-haiku-4-5':  { inputPer1M: 100_000_000n, outputPer1M:   500_000_000n }, // $1 / $5
  },
  deepseek: {
    'deepseek-v4-flash': { inputPer1M:  14_000_000n, outputPer1M:    28_000_000n }, // $0.14 / $0.28
    'deepseek-v4-pro':   { inputPer1M: 174_000_000n, outputPer1M:   348_000_000n }, // $1.74 / $3.48 (full post-discount)
  },
};

export function estimateCostMicrocents(
  provider: AiProviderName,
  model: string,
  inputTokens: number,
  outputTokens: number,
): bigint {
  // ... see cost-rates.ts for the implementation. BigInt arithmetic throughout.
}
```

All BigInt arithmetic — no float anywhere near money.

**Excluded by design** (see `cost-rates.ts` header for the full list):
- `gpt-4o` / `gpt-4o-mini` — grandfathered legacy as of 2026-Q1, replaced by the gpt-4.1 family. Drop entirely rather than mislead operators with a stale entry.
- `deepseek-chat` — deprecating alias. DeepSeek's docs warn the name is going away. `getAiConfig` rejects it at boot with a friendly message pointing to `deepseek-v4-flash`.
- GPT-5 family — overkill for short winback prompts.
- Cache-hit DeepSeek pricing — winback prompts are first-touch per-customer; no cache hits to exploit.
- DeepSeek v4-pro's temporary 75%-off promo (expires 2026-05-31) — the table carries the FULL post-discount price so the constant doesn't silently triple when the promo expires.

**Original draft had two errors** that were corrected during F batch 2 verification:
- `claude-haiku-4-5` was listed at $0.80/$4. Actual is **$1/$5** (per Anthropic's current docs). The under-stated price would have caused spend-ceiling math to under-count by 25%.
- `deepseek-chat` was listed at $0.14/$**2.80** output. Actual is $0.14/$**0.28** output (10× error in the draft). Same direction-of-bug as Haiku — would have over-counted output cost by an order of magnitude, prematurely tripping the spend ceiling.

Lesson for the next iteration: every provider rate added to this table MUST be backed by a corresponding anchored-value unit test in `cost-rates.test.ts` so a quiet refactor that changes `100_000_000n` to `100_000n` (off by 1000×) fails CI rather than ships silently.

### F-11 — Env vars

New env vars (added to **`packages/ai/src/config.ts`** — NOT `packages/config`; the cross-cutting core/Redis config lives there, but provider selection + per-provider API keys are an `@winback/ai` concern. The earlier "added to packages/config" phrasing in this section was stale and was corrected in F batch 2. Pattern mirrors `packages/shopify/src/config.ts`):

```
# Lock V7 (POST-EPIC-F-CONSCIOUS-DECISION.md) — launch defaults:
AI_PROVIDER=deepseek              # 'deepseek' | 'openai' | 'anthropic'
AI_MODEL=deepseek-v4-flash        # per-provider whitelist (see config.ts)
AI_MAX_TOKENS=300                 # max output tokens (1..4096, default 300)
AI_TEMPERATURE=0.7                # sampling temperature (0..2, default 0.7)
OPENAI_API_KEY=sk-...             # required iff AI_PROVIDER=openai
ANTHROPIC_API_KEY=sk-ant-...      # required iff AI_PROVIDER=anthropic
DEEPSEEK_API_KEY=sk-...           # required iff AI_PROVIDER=deepseek
```

**Allowed `AI_MODEL` per provider** (Zod `discriminatedUnion` enforces this at boot — see `config.ts`):
- `openai` → `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`
- `anthropic` → `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`
- `deepseek` → `deepseek-v4-flash`, `deepseek-v4-pro`

**Deprecated values** rejected at boot with operator-friendly messages (see `DEPRECATED_MODELS` in `cost-rates.ts`): `deepseek-chat`, `gpt-4o`, `gpt-4o-mini`.

**Boot validation** (same pattern as `ENCRYPTION_KEY`): only the ACTIVE provider's API key is required at boot. `AI_PROVIDER=deepseek` with no `OPENAI_API_KEY` set boots cleanly (per L6 — lazy provider construction means an unused provider's key is irrelevant). `getAiConfig()` throws `ConfigError` synchronously on misconfiguration; the AI Worker process won't start with a misconfigured active provider. Called at boot in `apps/drainer/src/index.ts` (alongside `getShopifyConfig()`) when batch 4 wires the AI Worker.

**CI:** `AI_PROVIDER=deepseek` + `AI_MODEL=deepseek-v4-flash` + a placeholder `DEEPSEEK_API_KEY` set in `ci.yml` solely for boot validation — no real LLM calls in CI; every provider is mocked in unit + integration tests. A dedicated end-to-end LLM test (gated behind `RUN_LLM_E2E=true` env var) runs locally when validating provider switching.

### F-12 — GDPR implications

`AiGeneration.generatedText`, `AiGeneration.systemPrompt`, `AiGeneration.userPrompt`, and `Message.generatedText` all contain customer PII (name, purchase history summary, generated text addressing the customer). The cascade chain ensures atomic deletion on GDPR redact:

```
Customer redact (gdpr.customer_redact handler)
  → DELETE Customer
    → CASCADE: AiGeneration WHERE customerId = $1
      → CASCADE: Message WHERE aiGenerationId IN (...)
    → CASCADE: Message WHERE customerId = $1 (direct path; redundant
                                               with the AiGeneration
                                               cascade but explicit)
```

Postgres handles all three CASCADE arrows atomically in a single DELETE statement. No additional GDPR-handler code needed.

**`AiSpendBucket`** contains zero PII. Cascades on Merchant delete only. No GDPR action needed.

**Compliance forensic note:** The GDPR processor's `processCustomerRedact` audit-log row should record the number of `AiGeneration` + `Message` rows deleted for that customer. This is a forensic note, not a separate handler write — covered by adding two `COUNT(*)` queries to the existing processor.

---

## Schema additions summary

| Model | Type | Epic F batch |
|---|---|---|
| `AiGeneration` | new table | batch 1 |
| `AiGenerationStatus` enum | new enum | batch 1 |
| `Message` (minimal — Epic G extends) | new table | batch 1 |
| `MessageStatus` enum (single value `draft`; G extends via ALTER TYPE) | new enum | batch 1 |
| `AiSpendBucket` | new table | batch 1 |
| `Merchant.aiGenerations` relation | additive | batch 1 |
| `Merchant.messages` relation | additive | batch 1 |
| `Merchant.aiSpendBuckets` relation | additive | batch 1 |
| `Customer.aiGenerations` relation | additive | batch 1 |
| `Customer.messages` relation | additive | batch 1 |
| `AiGeneration.message` 1:1 relation | additive | batch 1 |

No existing model fields change. No existing enums change. All additions are additive — zero migration risk to existing data.

**Cascade additions to schema header:**
- `Merchant → AiGeneration: CASCADE`
- `Merchant → Message: CASCADE`
- `Merchant → AiSpendBucket: CASCADE`
- `Customer → AiGeneration: CASCADE`
- `Customer → Message: CASCADE`
- `AiGeneration → Message: CASCADE`

**`TENANT_SCOPED_MODELS` additions in `packages/db/src/tenant-scope.ts`:**
- `'AiGeneration'`
- `'Message'`
- `'AiSpendBucket'`

Without these, the Prisma extension passes their reads + writes through without tenant injection or assertion — tenant-safety bug, same class as the Epic E session 2 `CustomerScore` gap caught during batch 4 of that session.

---

## New package: `packages/ai`

```
packages/ai/
  src/
    providers/
      interface.ts          # AiProvider interface + types + typed error classes
      openai.ts             # OpenAiProvider (also used for DeepSeek via OpenAI-compatible SDK)
      anthropic.ts          # AnthropicProvider
      deepseek.ts           # DeepSeekProvider (thin wrapper over openai SDK with different base URL)
      index.ts              # selectActiveProvider(config): AiProvider
    cost-rates.ts           # PROVIDER_COST_RATES + estimateCostMicrocents
    prompt-builder.ts       # buildWinbackPrompt (pure function)
    config.ts               # getAiConfig() — env validation
    index.ts                # public exports
  tests/
    build-winback-prompt.test.ts   # pure function unit tests
    cost-rates.test.ts             # microcent arithmetic unit tests
    providers/
      openai.test.ts               # mocked SDK
      anthropic.test.ts            # mocked SDK
      deepseek.test.ts             # mocked SDK
  package.json
  tsconfig.json
```

SDK deps:
- `openai` (official OpenAI SDK — also used for DeepSeek since DeepSeek exposes an OpenAI-compatible endpoint via a `baseURL` override)
- `@anthropic-ai/sdk`

Both are `dependencies` of `packages/ai` (not devDependencies — they're runtime deps of the AI Worker).

---

## Batch plan (5 batches, same arc as Epic E sessions)

| Batch | Scope | Key deliverables |
|---|---|---|
| 1 | Schema + migration + this design doc + TENANT_SCOPED_MODELS additions | `AiGeneration`, `Message` (minimal), `AiSpendBucket`, `AiGenerationStatus` + `MessageStatus` enums, cascade-policy header update, `QUEUE_NAMES.ai.generate` registration in `@winback/contracts`, `'AiGeneration' + 'Message' + 'AiSpendBucket'` added to `TENANT_SCOPED_MODELS` |
| 2 | `packages/ai` package | Provider interface + 3 concrete providers (OpenAI / Anthropic / DeepSeek), cost-rate table, `buildWinbackPrompt`, env config + boot validation, unit tests for all pure functions + mocked-SDK provider tests.  No DB, no drainer changes. |
| 3 | Repositories in `@winback/db` | `AiGenerationRepository` (create, markCompleted, markFailed), `AiSpendBucketRepository` (getOrCreate, incrementSpend via Postgres `INSERT ... ON CONFLICT DO UPDATE` — atomic row-lock on `@@unique([merchantId, date])`), `MessageRepository` (create with draft status; G later extends with status-transition methods).  Unit tests (mocked Prisma). |
| 4 | `handleCustomerStateChanged` handler + AI Worker | Drainer handler rewrite (noop → real).  AI Worker BullMQ consumer at `ai.generate`.  Spend-ceiling check + atomic increment.  Full handler unit tests.  AI Worker unit tests (mocked provider). |
| 5 | Integration tests | Real Postgres + mocked LLM provider.  End-to-end: `customer.state_changed` event → both `AiGeneration` + `Message` rows written → AI Worker job runs → both rows mutated to completed/draft + `AiSpendBucket` incremented.  Spend ceiling exceeded → generation rejected, no LLM call.  Concurrent jobs serialized via the Postgres `INSERT ... ON CONFLICT DO UPDATE` row-level lock on `@@unique([merchantId, date])` (parallel `processAiGenerateJob` calls land both increments without lost-update).  Non-retryable provider errors (`content_blocked` / `auth` / `invalid_request`) write `markFailed + AuditLog` in one tx with the correct action discriminant.  Race-replay regression lock (`markCompleted updatedCount=0` → skip downstream writes).  GDPR cascade chain verified end-to-end (delete Customer → AiGeneration + Message both gone; AiSpendBucket preserved — no Customer FK). |

---

## Edge cases

| Case | Handling |
|---|---|
| Merchant has no `Merchant.timezone` set | `AiSpendBucket.date` uses UTC.  No retroactive adjustment when timezone later enriches.  Monthly cap math is calendar-month UTC throughout. |
| Customer firstName is null | Prompt uses "valued customer" as salutation.  Prompt builder has its own null-safe name resolution (does NOT depend on the UI's `customerDisplayName` helper). |
| Provider returns empty content | `AiGeneration.status = failed`, `lastError = 'empty_response'`.  Message.generatedText stays empty string.  Message.status stays `draft` — G's dispatch worker can filter `WHERE generatedText != ''` when ready. |
| Provider content-filter rejection | `status = failed`, `lastError = 'content_filter'`.  Non-retryable.  Same Message-row outcome as empty content. |
| Provider 429 (rate limit) | BullMQ delay-retry with exponential backoff, max 3 retries.  `AiGeneration` stays `pending` during retries.  Spend ceiling re-checked on each retry attempt. |
| Provider 5xx | Same retry policy as 429. |
| Provider 401 (auth) | Non-retryable.  `lastError = 'provider_auth_failed'`.  Operator alert — API key wrong/expired. |
| `monthlyAiSpendCapCents` is 0 (merchant paused AI) | Spend-ceiling check rejects all generations immediately.  Operator-friendly switch for runaway-merchant containment. |
| Two concurrent state-change events for the same merchant | Per-merchant BullMQ concurrency = 1.  Jobs queue serially per merchant.  No double-spend race on `AiSpendBucket`. |
| `AiSpendBucket` row doesn't exist yet for today | `getOrCreate` upsert idempotent.  SELECT FOR UPDATE lock applies to the upserted row. |
| Customer deleted between state-change and AI Worker pickup | Worker reads `AiGeneration` row — if status !== `pending`, no-op (idempotent).  If both rows are cascade-deleted (Customer redact path), BullMQ job finds no row + exits cleanly without retry. |
| State oscillation (`at_risk → active → at_risk`) | Each `at_risk` entry generates a new `AiGeneration` + `Message`.  G's suppression (later epic) gates re-send. |
| Drainer crashes between writing AiGeneration row and enqueueing BullMQ job | `AiGeneration.status = pending` stays.  Operator surfaces stale-pending rows via `WHERE status = 'pending' AND createdAt < now() - interval '1 hour'`.  No automatic retry in F v1 — manual operator action.  M10 hardening: sweep cron. |
| BullMQ job dispatches but Worker process crashed mid-generation | BullMQ marks the job stalled; replays on the next worker pickup.  Worker's idempotent-replay check (`status !== pending` → no-op) handles the duplicate. |
| Shopify Admin API timeout during context read (step 6 in F-9) | Handler throws → drainer's per-row try/catch handles per the existing DLQ logic.  No AiGeneration row written — no orphan record.  Job becomes retryable per drainer's `isRetryable` classification. |

---

## What's NOT in Epic F scope (deferred)

- **Message delivery (SMS / email / Marketing Activities API)** — Epic G.  F generates the text + writes the draft `Message` row; G dispatches.
- **`Campaign` / `WorkflowStepExecution` FK columns on `Message`** — Epic G batch 1 ADDs these to the `Message` model.  F batch 1 ships only the minimal columns the AI Worker writes (`id`, `merchantId`, `customerId`, `aiGenerationId`, `status`, `generatedText`, `createdAt`, `updatedAt`).
- **`MessageStatus` enum values beyond `draft`** — Epic G's batch 1 ALTER TYPE ADD VALUE for `sent`, `suppressed`, `failed`, `bounced`, `opened`, `clicked`.
- **Merchant-facing generation review UI** — Epic G or post-G.  Merchants don't see generated messages in F; they appear in the campaign review flow in G.
- **Per-merchant AI provider selection** — v1 is platform-wide.  Future epic if merchants request choice.
- **Prompt versioning / A/B testing** — Future epic.  `AiGeneration.systemPrompt` + `userPrompt` stored for forensics; versioning infrastructure deferred.
- **Image generation** — Not in scope for winback messages.
- **Multi-language generation** — `read_locales` scope deferred per scopes audit.  English-only v1.
- **Backfill generation for existing at-risk customers** — Future operator script.  F only generates on new `customer.state_changed` events.
- **Cross-provider failover** — Q9 light lock.  M10.
- **Operator-editable cost-rate table** — Q9 light lock.  M10.
- **Human review / approval queue before send** — Q10 light lock.  Epic G.
- **`AiGeneration` retention sweep cron** — M10.  Forever retention v1.
- **Stale-pending generation sweep** — Edge case above.  M10 hardening cron.
- **Table-backed prompt templates (`PromptTemplate`)** — Q8 light lock.  Later F session or Epic G.

---

## Repository / service / package surface

| File | New / changed | Purpose |
|---|---|---|
| `packages/db/prisma/schema.prisma` | changed | Add `AiGeneration`, `Message`, `AiSpendBucket`, both enums, cascade-policy header |
| `packages/db/prisma/migrations/<ts>_epic_f_ai_generation/migration.sql` | new | Create three tables + two enums + cascades + tenant-scoped relations |
| `packages/db/src/tenant-scope.ts` | changed | Add `'AiGeneration'`, `'Message'`, `'AiSpendBucket'` to `TENANT_SCOPED_MODELS` |
| `packages/ai/` | new package | Provider interface, 3 providers, cost rates, prompt builder, env config |
| `packages/db/src/repositories/ai-generation.repository.ts` | new | Typed write chokepoint for `AiGeneration` (create, markCompleted, markFailed) |
| `packages/db/src/repositories/message.repository.ts` | new | Typed write chokepoint for `Message` (createDraft; G extends with status-transition methods) |
| `packages/db/src/repositories/ai-spend-bucket.repository.ts` | new | Typed chokepoint for `AiSpendBucket` (getOrCreate, incrementSpend via SELECT FOR UPDATE) |
| `packages/db/src/repositories/index.ts` | changed | Re-export new repos |
| `packages/db/src/index.ts` | changed | Re-export new repos |
| `packages/contracts/src/queue-names.ts` | changed | Add `QUEUE_NAMES.ai.generate` |
| `packages/contracts/src/audit-actions.ts` | changed | Add `AUDIT_ACTIONS.ai.generation_failed` (for content-filter + spend-ceiling rejections; G consumes for review-queue display) |
| `packages/config/src/index.ts` | changed | Add `AI_PROVIDER`, `AI_MODEL`, `AI_MAX_TOKENS`, `AI_TEMPERATURE`, provider API keys + boot validation |
| `apps/drainer/src/handlers/customer-state-changed.ts` | new | Replaces `handleNoop` for `customer.state_changed` |
| `apps/drainer/src/workers/ai-generate.worker.ts` | new | BullMQ Worker for `ai.generate` queue (same process as drainer) |
| `apps/drainer/src/dispatch.ts` | changed | Route `customer.state_changed` from `handleNoop` to `handleCustomerStateChanged` |
| `apps/drainer/src/index.ts` | changed | Construct AI Worker alongside outbox drain Worker |
| `apps/drainer/tests/handlers/customer-state-changed.test.ts` | new | Handler unit tests (mocked provider + repos) |
| `apps/drainer/tests/workers/ai-generate.worker.test.ts` | new | Worker unit tests (mocked provider + repos) |
| `apps/drainer/tests/integration/ai-generate.test.ts` | new | Epic F end-to-end integration tests — batch 5 (§F-9 handler + §F-8 worker, real Postgres, mocked LLM provider) |
| `EPIC-F-DESIGN.md` | new | This file |

---

## Audit checklist — before approving this doc

- [ ] All Q-locks (Q1–Q10) from session-start reflected and locked
- [ ] Provider abstraction interface fully specified (no provider-specific logic leaks into the handler or worker)
- [ ] Cost tracking uses BigInt microcents throughout — no float anywhere near money
- [ ] Spend ceiling enforcement is pre-call (not post-call) — we never owe more than the cap
- [ ] Atomic-increment pattern on `AiSpendBucket` documented for concurrent-job safety (Postgres `INSERT ... ON CONFLICT DO UPDATE` row-lock on `@@unique([merchantId, date])`)
- [ ] GDPR cascade chain documented (`Customer → AiGeneration → Message` all CASCADE; `Customer → Message` direct CASCADE for redundant safety)
- [ ] Trigger surface explicit: which state bands generate, which don't (F-3)
- [ ] Trigger language is "drainer at customer.state_changed", not "G at dispatch time" — Q4 reconciliation locked
- [ ] Shopify API reads outside DB transaction (no external HTTP inside `prisma.$transaction`) — F-9 step 6
- [ ] AI Worker runs in `apps/drainer`, not `apps/scheduler` — event-driven, not time-driven
- [ ] No real LLM calls in CI — mocked provider in tests, env-gated E2E
- [ ] `AiGeneration` + `Message` rows BOTH pre-created in the same tx before BullMQ job enqueue (forensic record + clean ownership)
- [ ] Idempotent worker pickup (`status !== 'pending'` → no-op)
- [ ] `Message.status` enum minimal (single value `draft`) in F batch 1; G extends via ALTER TYPE ADD VALUE
- [ ] `'AiGeneration'`, `'Message'`, `'AiSpendBucket'` added to `TENANT_SCOPED_MODELS` in batch 1 (locked as a tenant-safety task — not optional)
- [ ] Backfill generation explicitly out of scope
- [ ] Message delivery explicitly out of scope (Epic G)
- [ ] `Campaign` / `WorkflowStepExecution` FKs on `Message` explicitly deferred to Epic G batch 1
- [ ] Env-var boot validation pattern documented (same as `ENCRYPTION_KEY`)
- [ ] Provider failover scope: same-provider retry only; cross-provider M10
- [ ] Content safety scope: provider built-in only; review queue Epic G
- [ ] No code lands until this doc is approved

---

*This document is the source of truth for Epic F AI generation.  Update in the same commit as any handler, worker, repository, schema, or provider change that affects generation, Message ownership, cost tracking, or prompt construction.*
