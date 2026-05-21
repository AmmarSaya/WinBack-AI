# Points to Consider — WinBack-AI

> Generated from senior code review session, 2026-05-16.
> Updated 2026-05-18 with findings from Pre-Epic-E security + correctness audit (PRE-EPIC-E-AUDIT.md).
> These are standing issues and learning points that apply across the entire project lifecycle.

---

## ✅ Resolved — Closed Before Epic E

### 1. No LICENSE File
- **Resolved:** Proprietary license added. © 2026 Ammar Saya.

### 2. No README.md
- **Resolved:** Minimum-viable README shipped in housekeeping commit `83d8938`.

### 3. `master` Branch — No Protection
- **Resolved:** Renamed to `main`, branch protection enabled, housekeeping commit `83d8938`.

### 9. No Dependabot Configured
- **Resolved:** `.github/dependabot.yml` shipped in housekeeping commit. Weekly cadence, npm + github-actions. Groups block added.

### 7. The Async ALS Integration Test Gap
- **Resolved:** `apps/web` integration harness built (sessions 1 + 2). 27 integration tests. Harness caught two real bugs before merge.

### C-1 [HIGH] — `order.placed` / `order.updated` payload contract mismatch
- **Resolved:** Producer-aligned schema + documented stub handler shipped in `cd5fd3d` (PR `fix/c1-order-payload-mismatch`). Per CP-2 §Q1, the real attribution work lives inline in the drainer's Order-upsert handler at Epic E/H1 — no separate consumer. `QUEUE_NAMES.attribution.compute` + `WinbackQueues.attributionCompute` removed in the same commit (rule 36).
- **Tests:** +3 (handler producer-shape validation). 431/431 unit.

### S-2 [MEDIUM] — Shop strings never normalized before persistence
- **Resolved:** `normalizeShopDomain` now called at all three ingest entrypoints — `/auth`, `/auth/callback`, webhook ingest — in `ffdafc1` (PR `fix/s2-shop-domain-normalization`). HMAC verification in callback still uses raw query object by design.

### S-3 [MEDIUM] — `findUnique({ where: { shop } })` on Merchant bypasses tenant isolation
- **Resolved:** Merchant branch in `enforceTenantScopeOnRead` now requires `where.id === scope.merchantId` for all tenant-scope reads — the `!isFindUnique` exception removed in `484c51d` (PR `fix/s3-merchant-findunique-tenant-check`). Cross-tenant Merchant reads still legal under `withSystemScope`; verified across all 5 production call sites pre-fix.
- **Tests:** +3 regression locks in `tenant-scope.test.ts`. 434/434 unit.

### Drainer integration harness — no ingest-to-drain end-to-end coverage
- **Resolved:** `pnpm drainer:test` harness shipped in `756c489` (PR `feat/drainer-integration-harness`). 8 integration tests covering producer-shape happy paths (the C-1 regression lock channel — payloads match what `webhook-ingest.server.ts:142-154` writes, so any future producer drift fails loudly), MARK_BEFORE_INVOKE policy with real `processShopRedact` cascade + Phase 2 deferred-failure marker semantics, and DLQ logic (non-retryable immediate DLQ, retryable below ceiling → markFailed, retryable AT ceiling → DLQ — the `row.attempts + 1 >= MAX` off-by-one lock). Shared test helpers extracted to `@winback/db/test-utils` (third-caller trigger from session-1 `setup.ts`); `apps/web` and `packages/db` callers updated to thin re-export shims with no behavioral change.
- **Tests:** +8 drainer integration. Workspace totals: 434/434 unit + 27/27 web + 13/13 db + 8/8 drainer + 4/4 queue = **486 across all suites**.

### S-4 [MEDIUM] — `OrderLineItem` unique constraint missing `merchantId`
- **Resolved:** Migration `20260521120000_orderlineitem_tenant_unique` swaps `@@unique([orderId, shopifyLineItemId])` for `@@unique([merchantId, orderId, shopifyLineItemId])`. DROP + CREATE in one tx (atomic; no window without a unique guard). Repository's `tx.orderLineItem.upsert` `where` accessor updated to `merchantId_orderId_shopifyLineItemId`. Behaviorally identical for uniqueness (orderId → merchantId is 1:1 via FK); structurally consistent with the rest of the schema's tenant-scoped composite uniques.
- **Tests:** +1 unit regression test locking the new `where` shape via `toEqual` (catches both key-rename and field-drop regressions). db unit 279 → 280. db int 12/13 (T1 planner flake unrelated). web int 31/31. drainer int 28/28.

### 4. No CI/CD Pipeline Running Tests on PRs
- **Resolved:** `.github/workflows/ci.yml` shipped (commit `4c30b56`). Single-job pipeline runs `pnpm build` → `pnpm -r test` → `prisma migrate deploy` → db/web/drainer/queue integration suites against Postgres + Redis service containers. Triggers on every PR against `main` and every push to `main`. Branch protection ruleset wired in GitHub UI post-merge requiring both `CI / build + test` and `migration-drift / drift-check` status checks. Old `integration.yml` (master-targeted, no Redis, never gated) deleted in the same commit. T1 smoke-test planner flake fixed in the same change (`SET LOCAL enable_seqscan = OFF` before EXPLAIN) so the gate's not pre-flaky.

### 5. `ENCRYPTION_KEY` Boot Validation
- **Resolved (already in place — entry was stale documentation):** [packages/shopify/src/config.ts:39-48](packages/shopify/src/config.ts) — `getShopifyConfig`'s Zod schema validates `ENCRYPTION_KEY` (`.min(1)` + `.refine(base64-decoded length === 32)`). Validation runs at process boot in all three long-running apps: [apps/web/app/entry.server.tsx:24-25](apps/web/app/entry.server.tsx) calls `getCoreConfig()` + `getShopifyConfig()` at module load (before binding the HTTP port); [apps/drainer/src/index.ts](apps/drainer/src/index.ts) + [apps/scheduler/src/index.ts](apps/scheduler/src/index.ts) call `getShopifyConfig()` in `main()` before constructing Workers. Apps that don't touch Session encryption (`apps/cli`) intentionally skip. Original entry was written before the boot paths were wired; never got updated when they shipped.

---

## 🔴 Must Fix Before Epic E

_All pre-Epic-E blockers resolved as of `756c489`. Section retained for future use — when a new must-fix lands during Epic E or after, it goes here. Epic E is unblocked._

---

## 🟡 Fix Before M10 (Hardening Pass)

### P-1 [LOW] — Prisma `@updatedAt` columns lack DB-level DEFAULT

- **Source:** Epic F batch 1 anomaly (c), surfaced during batch 2 audit.
- **Issue:** Prisma generates `NOT NULL` columns without a DB-level `DEFAULT CURRENT_TIMESTAMP` for `@updatedAt` fields. Inserts via the Prisma client work (the client sets the value on every write); raw SQL `INSERT` statements that omit the column fail with a NOT NULL violation. Doesn't bite production code today (every write path goes through Prisma), but it's a footgun for any future raw-SQL fixture, manual operator hotfix, or migration that backfills via `INSERT ... SELECT`.
- **Affected columns** (audited 2026-05-21 against `schema.prisma` HEAD):
    - `Merchant.updatedAt`
    - `MerchantSettings.updatedAt`
    - `BillingSubscription.updatedAt`
    - `Session.updatedAt`
    - `Customer.updatedAt`
    - `CustomerScore.updatedAt`
    - `Product.updatedAt`
    - `ProductVariant.updatedAt`
    - `Order.updatedAt`
    - `OrderLineItem.updatedAt`
    - `BackfillJob.updatedAt`
    - `Message.updatedAt` (Epic F batch 1)
    - `AiSpendBucket.updatedAt` (Epic F batch 1)
- **`@default(now())` createdAt columns** — verified safe; Prisma DOES emit `DEFAULT CURRENT_TIMESTAMP` for those. Only `@updatedAt` is affected.
- **Fix:** single migration adding `DEFAULT CURRENT_TIMESTAMP` to each `@updatedAt` column in one transaction. Idempotent — re-running is a no-op (`ALTER COLUMN ... SET DEFAULT` is idempotent). Verify no integration-test path relies on Prisma's setting behaviour in a way the SQL default would break.
- **Action:** M10 hardening. Bundle with the S-5 / C-5 / M-1 scope-assertion cleanup pass.

### S-5 [LOW] — `web.index_lookup` system-scope reason reused across multiple loaders
- **Source:** Epic E UI session audit (2026-05-21).
- **Issue:** The `/customers` and `/settings` loaders both reuse `SYSTEM_SCOPE_REASONS.web.index_lookup` for their pre-tenant Merchant.findUnique. Operations are functionally identical (look up Merchant by `shop`), so the reuse is correct, but a log line tagged `web.index_lookup` no longer disambiguates which route triggered the lookup — muddies the audit trail.
- **Fix:** Either register a generic `web.shop_lookup` reason that all three loaders use, OR register per-route reasons (`web.customers_lookup`, `web.settings_lookup`). Either is one-line addition in `@winback/contracts/src/system-scope-reasons.ts`.
- **Action:** M10 hardening. Auditability concern, not correctness — no runtime error path.

### C-5 [LOW] — `OutboxRepository` mark-* methods have no scope assertion
- **Source:** PRE-EPIC-E-AUDIT.md, Pass 2.
- **Issue:** `markProcessed`, `markFailed`, `markDeadLettered`, `markDeferredFailed` rely on caller being in system scope. No guard at method level. Latent footgun if a future caller invokes from tenant scope.
- **Fix:** Add `scope?.kind === 'system'` guard at top of each mark-* method, mirroring `claimBatch`.
- **Action:** M10 hardening. Drainer is the only caller today and is correctly scoped.

### M-1 [LOW] — `MerchantRepository.hardDelete` has documented scope contract but no assertion
- **Source:** POST-EPIC-E-AUDIT.md, Pass 2, LOW-4.
- **Issue:** Method docstring says "MUST be called from system scope" but no top-of-method assertion enforces it. Same footgun pattern as C-5 — the Prisma extension's Merchant branch in tenant scope would assert `where.id === scope.merchantId` (structurally allowed), but the semantics of "deleting the row that defines the active scope" are wrong. Caller-only enforcement breaks the moment a future caller forgets.
- **Fix:** Add `const scope = getTenantScope(); if (scope?.kind !== 'system') throw new Error('hardDelete requires system scope')` at the top of `hardDelete`, mirroring `OutboxRepository.claimBatch`. One-liner.
- **Action:** M10 hardening. Only legitimate caller today is `gdpr-processor.processShopRedact`, which is correctly in system scope. Same risk profile as C-5 — bundle the two fixes in one cleanup pass.

### CI-1 [LOW] — `drift-check` is advisory, not required, on PRs
- **Source:** Branch protection rollout for `ci.yml` (commit `4c30b56`).
- **Issue:** `migrate-diff.yml` filters on `paths: [packages/db/prisma/schema.prisma, packages/db/prisma/migrations/**]` — so the `drift-check` job doesn't run on non-DB PRs.  Adding it to the required-status-checks list traps non-DB PRs at "Expected — waiting for status to be reported" forever.  We removed it from the required list (functional unblock) so it now runs + is visible on DB-touching PRs but is advisory, not blocking.  A DB-touching PR with a failing drift-check COULD be merged if the developer ignores the visible red ❌.
- **Fix (option C from the rollout conversation):** Fold the drift-check job INTO `ci.yml` as a step (drops the path-filter trap entirely; `ci.yml` always runs, drift-check always runs as part of it).  Delete `migrate-diff.yml`.  Re-add `CI / build + test` as the single required check (already required).  ~10 lines of YAML, no workflow restructure.
- **Action:** M10 hardening.  The drift it catches (schema vs migrations divergence) is a low-frequency failure mode on a monorepo with disciplined committers; advisory red ❌ in practice catches it.  Not blocking any current work.

### 10. Prisma 5.22.0 — No Upgrade Plan
- **Action:** Quarterly review note in `CONTRIBUTING.md`. One PR per major dep upgrade, never opportunistic bumps.

### 11. Shopify Scopes — Audit Before First Merchant
- **Resolved (audit doc):** `SHOPIFY-SCOPES-AUDIT.md` shipped + approved 2026-05-21.  Locks the full Epic A–H scope union at 8 scopes: `read_customers, read_orders, read_products, read_inventory, read_price_rules, write_discounts, write_marketing_events, read_marketing_events`.  Per-epic rationale + deferred scopes (`read_locations`, `read_locales`) + rejected scopes (`read_shopify_payments_disputes`, `write_customers`) all documented.  Migration strategy locked: pre-launch full union (the only path that avoids the re-auth gauntlet).
- **Remaining pre-launch operational work (NOT part of the audit deliverable):** update `SHOPIFY_SCOPES` env in deploy config, sync the Partners-portal app config, update `apps/web/.env` template + handoff docs, update `.github/workflows/ci.yml` env block.  These tasks reference the audit doc but ship as separate pre-launch commits — they are not gated by the audit and not blocking any current epic.

### 13. No `CONTRIBUTING.md`
- **Action:** Create with standing rules, registry-first pattern, ALS discipline, BigInt boundary rule, commit convention.

### 14. No Conventional Commit Enforcement
- **Action:** Add `commitlint` + `husky`. Already using the format; enforce it at commit time.

### 15. Webhook Ingest Rate Limiting
- **Issue:** No rate limiting on HTTP ingest. BullMQ queuing helps but doesn't protect the endpoint from retry floods.
- **Action:** Document and implement a rate-limiting strategy before launch.

---

## 📚 Learning Points — Standing Knowledge

### 16. Multi-Tenant Failure Mode in Production
- One tenant isolation bug = Shopify partner account banned. Tenant isolation test exists in `loaders.test.ts`. Run against real dev stores too.

### 17. GDPR Webhooks Required for Public Listing
- `customers/data_request`, `customers/redact`, `shop/redact` must return 200 within 5 seconds. Ingest path tested. Drainer's GDPR handler also needs integration coverage (see drainer harness gap).

### 18. Shopify API Rate Limits — Per-Shop, Not Global
- BullMQ rate limiters must be keyed by `merchantId`. One merchant's burst must not starve others.

### 19. `BigInt` JSON Serialization is a Runtime Error
- `JSON.stringify(BigInt(1))` throws. TypeScript won't catch it. Document in `CONTRIBUTING.md` with the correct pattern: `amount.toString()` at every JSON boundary.

### 20. Plan Shopify Billing API Before Epic G
- Usage Billing or Recurring Application Charges must be wired before campaign features ship. Retroactive billing addition is painful.

### 21. Always Work in Feature Branches
- Every piece of work on a branch + PR. CI runs. Audit trail exists. No direct commits to `main`.

### 22. Shopify Webhook Delivery is Not Ordered
- Never assume `orders/create` arrives before `customers/update` for the same event. Design every handler for out-of-order delivery.

### 23. Drainer Harness Gap is the Discovery Channel for Producer/Consumer Bugs
- C-1 hid because mocked-Prisma tests let developers hand-build whatever payload they want. Any producer/consumer contract mismatch is invisible until a real ingest-to-drain test runs. This is why the drainer harness ships before Epic E.

### 24. Don't Let Infrastructure Become the Product
- After the drainer harness, the burden of proof shifts to "what does a merchant see different?" Epic E ships, then F, then G.

---

## ✅ Things You're Already Doing Right — Keep Doing Them

- Architecture decisions documented in `ARCHITECTURE.md` with rationale and constraints.
- Pre-commit audit checklists before each phase.
- No fake data in the UI — honest empty states that name the unlocking epic.
- Tenant isolation via Prisma extension with compile-time + runtime enforcement.
- `withSystemScope` with a typed, registered reason — no ad-hoc escapes.
- `AuditLog` written in the same transaction as the action it records.
- `BigInt` for all monetary values — no `Float` anywhere near money.
- API version pinned with regex validator in config.
- pnpm overrides locking critical dependency versions.
- Idempotency at schema level (`@@unique` constraints), not just application logic.
- Attribution contract documented before any code lands (CP-2 pattern).
- Integration harness catches real bugs before merge (two caught in sessions 1 + 2).
- Conventional Commits on every commit — readable history, automated changelog-ready.

---

*Review this file at the start of every new epic. Mark items resolved with a date.*
