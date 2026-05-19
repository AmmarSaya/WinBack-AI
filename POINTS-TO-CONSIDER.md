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

---

## 🔴 Must Fix Before Epic E

_All pre-Epic-E blockers resolved as of `756c489`. Section retained for future use — when a new must-fix lands during Epic E or after, it goes here. Epic E is unblocked._

---

## 🟡 Fix Before M10 (Hardening Pass)

### S-4 [MEDIUM] — `OrderLineItem` unique constraint missing `merchantId`
- **Source:** PRE-EPIC-E-AUDIT.md, Pass 1.
- **Issue:** Every other tenant-scoped model uses `@@unique([merchantId, shopifyXxxId])`. `OrderLineItem` uses `@@unique([orderId, shopifyLineItemId])`. Extension's findUnique skip is unsafe for this model.
- **Fix:** Change to `@@unique([merchantId, orderId, shopifyLineItemId])` in a future migration.
- **Action:** M10 hardening. Risk does not increase with Epic E.

### C-5 [LOW] — `OutboxRepository` mark-* methods have no scope assertion
- **Source:** PRE-EPIC-E-AUDIT.md, Pass 2.
- **Issue:** `markProcessed`, `markFailed`, `markDeadLettered`, `markDeferredFailed` rely on caller being in system scope. No guard at method level. Latent footgun if a future caller invokes from tenant scope.
- **Fix:** Add `scope?.kind === 'system'` guard at top of each mark-* method, mirroring `claimBatch`.
- **Action:** M10 hardening. Drainer is the only caller today and is correctly scoped.

### 4. No CI/CD Pipeline Running Tests on PRs
- **Issue:** Workflow exists but does not gate PRs. Bad push can merge without running tests.
- **Action:** Wire workflow to run `pnpm build`, `pnpm -r test`, `pnpm db:test`, `pnpm web:test:run` on every PR. Add branch protection status check requirement.

### 5. `ENCRYPTION_KEY` Boot Validation
- **Issue:** No hard-throw if `ENCRYPTION_KEY` is missing or under 32 bytes at startup.
- **Action:** Add explicit validation in `packages/config/src/index.ts`.

### 10. Prisma 5.22.0 — No Upgrade Plan
- **Action:** Quarterly review note in `CONTRIBUTING.md`. One PR per major dep upgrade, never opportunistic bumps.

### 11. Shopify Scopes — Audit Before First Merchant
- **Issue:** Current scopes likely incomplete for Epics F and G. Post-install scope additions force re-authorization.
- **Action:** Enumerate final scope requirements across all epics before any merchant installs.

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
