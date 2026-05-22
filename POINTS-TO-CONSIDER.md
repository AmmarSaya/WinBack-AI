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

### C-5 [LOW] — `OutboxRepository` mark-* methods have no scope assertion
- **Resolved 2026-05-23** on `chore/m10-scope-assertions` (v1 Section 6 — M10 one-liner pass). Added the same `getTenantScope()?.kind !== 'system'` guard at the top of `markProcessed`, `markFailed`, `markDeadLettered`, `markDeferredFailed`, AND `requeueDeadLettered` (the 5th method noted in POST-EPIC-E-AUDIT was folded in during the audit gate). Mirrors the existing `claimBatch` guard pattern. Each guard throws `Error('OutboxRepository.<method> requires system scope')`.
- **Tests:** +6 regression locks in `tenant-scope.test.ts` ("OutboxRepository — system-scope guards (C-5 regression locks)" describe block): five tests verify each method throws when called from tenant scope; sixth verifies all five throw with no scope at all.
- **Production caller audit:** verified all real callers already in system scope before the guard landed — `apps/drainer/src/drainer.ts` (outbox.drain), `apps/cli/src/commands/dead-letter.ts` (outbox.dead_letter), `apps/cli/src/commands/replay.ts` (outbox.replay). No code-side migration required; guard is pure defense-in-depth against future regressions.

### M-1 [LOW] — `MerchantRepository.hardDelete` has documented scope contract but no assertion
- **Resolved 2026-05-23** on `chore/m10-scope-assertions` (same commit as C-5). Added the one-line scope guard at the top of `hardDelete`. Throws `Error('MerchantRepository.hardDelete requires system scope')`. `getTenantScope` newly imported into `merchant.repository.ts` for this purpose.
- **Tests:** existing unit tests wrapped in `withSystemScope('test.merchant_hard_delete', …)`; +2 regression locks in `merchant-repository.test.ts` covering tenant-scope and no-scope call paths.
- **Production caller audit:** only legitimate caller is `gdpr-processor.processShopRedact`, already in `withSystemScope(SYSTEM_SCOPE_REASONS.gdpr.shop_redact, …)`. No migration.

### S-5 [LOW] — `web.index_lookup` system-scope reason reused across multiple loaders
- **Resolved 2026-05-23** on `chore/m10-scope-assertions` (same commit). Per-route reasons registered: `SYSTEM_SCOPE_REASONS.web.customers_lookup` for the `/customers` loader, `SYSTEM_SCOPE_REASONS.web.settings_lookup` for the `/settings` loader. `web.index_lookup` retained for the `/_index` loader (unchanged). Now log lines surfacing the scope reason can disambiguate which loader opened the scope.
- **Tests:** +4 regression locks in `tenant-scope.test.ts` ("SYSTEM_SCOPE_REASONS.web — per-route entries (S-5 regression lock)") covering both new entries, membership in `ALL_SYSTEM_SCOPE_REASONS`, runtime regex pass via `withSystemScope` smoke check, and pinning of the original `web.index_lookup`.

### I-1 [LAUNCH BLOCKER] — GDPR webhook topics rejected by `webhookSubscriptionCreate`
- **Resolved 2026-05-23** on `fix/install-gdpr-webhook-registration`. The install flow's `subscribeAllWebhooks` in `packages/shopify/src/admin/webhook-subscriptions.ts` looped over both `WEBHOOK_TOPIC_TO_EVENT` AND `GDPR_TOPICS` and dispatched every topic via `webhookSubscriptionCreate`. The three GDPR topics (`customers/data_request`, `customers/redact`, `shop/redact`) are NOT valid values for the `WebhookSubscriptionTopic` enum on that mutation — Shopify rejected each with `Variable $topic of type WebhookSubscriptionTopic! was provided invalid value` (prod logs 2026-05-22 20:34 UTC). The receive path treats any per-topic error as terminal (`auth.callback.tsx:168-186` calls `restartFlow`), so the bug bricked the install loop — not silent, fully terminal.
- **Fix:** `subscribeAllWebhooks` now loops only over `Object.keys(WEBHOOK_TOPIC_TO_EVENT)` (10 commerce + lifecycle topics). The 3 GDPR topics are declared at app level via Partners Dashboard → App Settings → Compliance Webhooks (per OPERATIONS.md §4 checklist item). `GDPR_TOPIC_TO_EVENT` + `GDPR_TOPICS` retained — still used by the receive path's `getOutboxEventForTopic` to route delivered GDPR webhooks to `gdpr.*` outbox events.
- **Tests:** new `packages/shopify/tests/webhook-subscriptions.test.ts` (5 regression locks): all business topics subscribed; zero GDPR topics in the call set (the I-1 regression lock); callbackUrl threaded correctly; per-topic userErrors captured without throwing; thrown errors captured per-topic without aborting the loop. Existing `webhook-topics.test.ts` unchanged (constants still valid).
- **Operator step (paired with this commit, REQUIRED before App Store submission):** register the 3 GDPR URLs in Partners Dashboard per the new OPERATIONS.md §4 checklist item. Code change alone removes the install-loop trigger; without the dashboard step Shopify never delivers the GDPR topics. Both halves required.
- **Long-term:** evaluate `shopify.app.toml` as a single version-controlled source-of-truth for app-level config (privacy_compliance + scopes + redirect URLs). See M-7 below.

### P-1 [LOW] — Prisma `@updatedAt` columns lack DB-level DEFAULT
- **Resolved 2026-05-23** in `c0a7f4f` (PR `fix/p1-updatedat-defaults`). Schema-driven fix: each affected Prisma model's `updatedAt` field now declares the canonical `@default(now()) @updatedAt` pairing. Migration `20260523120000_add_updatedat_defaults` adds `DEFAULT CURRENT_TIMESTAMP` to the column at the DB layer for each of the 11 affected models. The `@updatedAt` decorator still drives runtime writes (Prisma client wins); the DEFAULT catches the raw-SQL-INSERT path where the column is omitted.
- **Original P-1 list was overstated by 2.** Audit during the fix surfaced that `Session.updatedAt` and `OrderLineItem.updatedAt` (both originally listed in this section) do not exist in the schema — Session is Shopify-adapter-owned and has no `@updatedAt` field; OrderLineItem rows are immutable post-insert and have no `@updatedAt` field. Actual affected list is 11 models (not 13): Merchant, MerchantSettings, BillingSubscription, Customer, CustomerScore, Product, ProductVariant, Order, BackfillJob, Message, AiSpendBucket. The migration SQL header enumerates the 7 models excluded by design (no `@updatedAt`) for future-reader context.
- **First production migration against live Neon.** Applied via Sequence B — merge to main, then `pnpm --filter @winback/db exec prisma migrate deploy` against the Neon DATABASE_URL from local. Verified post-apply via Neon MCP `information_schema.columns` query: all 11 affected columns show `column_default = 'CURRENT_TIMESTAMP'`. Postgres 18 (Neon) rendering matched Postgres 16-alpine (test container) rendering exactly — no version-specific surface bit us.
- **Migration shape:** hand-authored because the local shadow Postgres was not reachable during the batch (see M-5 below). Verified by applying against a fresh Postgres 16-alpine container after `pnpm db:test:down` removed the prior volume — full migration history applied from zero, all 18 base tables created, then the 11 `ALTER COLUMN ... SET DEFAULT CURRENT_TIMESTAMP` statements ran in sequence. Idempotent — re-running is a Postgres no-op.
- **No code behaviour change.** Prisma client continues to set `updatedAt` explicitly on every write; the DEFAULT is invisible to the client and only catches the raw-SQL-INSERT-omits-column edge case. No integration tests broke (all 13 db int still green; all 763 unit tests green).

---

## 🔴 Must Fix Before Epic E

_All pre-Epic-E blockers resolved as of `756c489`. Section retained for future use — when a new must-fix lands during Epic E or after, it goes here. Epic E is unblocked._

---

## 🟡 Fix Before M10 (Hardening Pass)

### I-2 [HARDENING] — Reinstall webhook subscription collision
- **Source:** Production install testing 2026-05-22 20:34 UTC, surfaced alongside I-1. Pre-existing bug, not introduced by recent work.
- **Issue:** When the app reinstalls WITHOUT a prior uninstall (Partners Dashboard refresh, OAuth re-run, scope-change re-consent, dev experimentation), the previous install's webhook subscriptions are still active on Shopify's side. The install path tries to CREATE fresh subscriptions for the 10 business topics; Shopify rejects each with `field: ['webhookSubscription', 'callbackUrl'] message: 'Address for this topic has already been taken'`. The normal install + uninstall + reinstall lifecycle works correctly; the narrow failing path is reinstall WITHOUT prior uninstall.
- **Severity:** HARDENING, not LAUNCH BLOCKER. Real merchants typically uninstall before reinstalling via Shopify's UI; edge cases (scope changes, OAuth token rotation, dev experimentation) hit it.
- **Recommended fix:** in the install flow, BEFORE calling `webhookSubscriptionCreate` for each business topic, query existing subscriptions via the `webhookSubscriptions` query. For each topic: if an active subscription with the matching callbackUrl already exists → skip (no-op); if an active subscription exists with a DIFFERENT callbackUrl → call `webhookSubscriptionUpdate` (idempotent + handles staging→prod URL drift); if none exists → call `webhookSubscriptionCreate` (existing path). Same install-flow code path as I-1; bundles cleanly into one PR.
- **Action:** next session (planned bundle with the I-1 follow-up after the operator-side Partners Dashboard registration lands).

### M-3 [LOW] — `getRedisConfig` scheme validation should be context-aware
- **Source:** Render-side Upstash → Render Key Value migration 2026-05-22. `REDIS_URL` on all 3 services now points at the internal Render Key Value endpoint (`redis://red-<hostname>:6379`, plain TCP — internal Render network is private, no TLS required). Production accepted `redis://` without code changes because `getRedisConfig`'s scheme validator already permits both `redis://` and `rediss://`.
- **Issue:** The current validator is too permissive. A production deploy that accidentally points at a public `redis://` endpoint (e.g., a misconfigured Upstash URL with TLS stripped) would boot cleanly when it should refuse. The Render internal pattern (`redis://red-[a-z0-9]+`) is the only legitimate plain-TCP case in production.
- **Recommended fix:** when `NODE_ENV=production`, require `rediss://` UNLESS the hostname matches the Render internal pattern `/^red-[a-z0-9]+/`. Friendly error message naming the production-TLS rule + the Render-internal exception.
- **Action:** M10 hardening. Non-blocking — current production deploy is Render-internal so the validator's permissiveness has no live exposure.

### M-4 [LOW] — Drainer health endpoint + alerting
- **Source:** Upstash free-tier limit incident 2026-05-22. The drainer kept polling against a saturated Redis tier (500K commands/month exhausted within ~2 weeks of dev-store-only traffic — BullMQ idle polling burns 30K–100K commands/worker/day with zero real work). Silent failure surface: no operator visibility until install testing revealed it.
- **Issue:** No drainer-side health endpoint and no Render-managed alerting. Drainer + scheduler are Background Workers (no HTTP surface), so they can't be probed by Render's standard health check. Failure modes (Redis exhausted, Postgres unreachable, queue stalled) go undetected until merchant-visible.
- **Recommended fix:** Two parts. (a) Add a lightweight HTTP listener to drainer + scheduler (or a separate `/healthz` route on the web service that probes drainer queue + Redis + Postgres). The listener pings Redis (`PING`) + runs a trivial Postgres SELECT, returns 200 on both green / 503 otherwise. (b) Configure a Render-managed uptime check on the endpoint with alert to operator email. Specifics deferred to M10 design.
- **Action:** M10 hardening. The Render Key Value migration removed the immediate Upstash-exhaustion threat; this is the broader visibility gap that incident exposed.

### M-5 [LOW] — Shadow Postgres not provisioned for `prisma migrate dev`
- **Source:** P-1 batch (`fix/p1-updatedat-defaults`, 2026-05-23). Surfaced when the migration needed to be hand-authored because `prisma migrate dev --create-only` could not run.
- **Issue:** `prisma migrate dev` requires a reachable shadow Postgres instance to detect drift and generate migration SQL. The repo's `.env.example` references `SHADOW_DATABASE_URL` as commented-out local config; no shadow DB is actually provisioned. Result: the canonical "generate-via-Prisma" migration workflow is unavailable; new migrations have to be hand-authored.
- **Why this is a real footgun:** hand-authored SQL was acceptable for P-1 (trivial additive `ALTER COLUMN ... SET DEFAULT` × 11). It is unsafe for migrations involving:
  - Column renames (Prisma emits a specific `RENAME COLUMN` sequence that's hard to reproduce by hand without breaking transactional safety)
  - Type changes (Prisma emits `USING` clauses and casts that are easy to miss)
  - Constraint changes that interact with existing data (Prisma sequences these to avoid lock cascades)
  - Data backfills (`INSERT ... SELECT` patterns in migrations where Prisma's emitted shape is non-obvious)
- **Drift-check exposure:** the longer we hand-author migrations, the more likely a subtle difference between hand-authored SQL and what Prisma would have generated triggers permanent drift-check noise (whitespace, statement ordering, exact SQL keyword spelling, EOF newline). P-1 dodged this because the shape is mechanical; the next migration may not.
- **Fix options:**
  - (a) **Configure a Neon branch as shadow.** Cheapest: Neon free-tier supports unlimited branches; create a `shadow` branch on the `winback-ai` project and wire its connection string to `SHADOW_DATABASE_URL` in dev. Trade-off: branches share the project's compute quota.
  - (b) **Local Docker Postgres.** Add a `postgres-shadow` service to `docker-compose.dev.yml` reachable at `localhost:5434` (or any unused port). `pnpm db:dev:up` brings it up alongside the main dev DB. Trade-off: another container to manage; only matters when running `prisma migrate dev`.
  - (c) **Use the existing test container at port 5433 as shadow.** Hack-ish but zero new infrastructure. Trade-off: shadow and test DB share a container; running `prisma migrate dev` while integration tests run would clobber each other.
- **Recommendation:** option (a) — Neon branch. Aligns with the rest of the prod-DB stack on Neon; zero local infra to maintain; branches are isolated and free on the current Neon tier.
- **Action:** M10 hardening. Hand-authoring is the workaround until this lands. Any non-trivial migration before this is fixed must be applied to a Neon branch first as a verification step (manual diff against Prisma's expected output) before landing on main.

### M-6 [LOW] — `OutboxEvent.attempts` increments on retry only (semantic note)
- **Source:** Empirical observation during production install testing 2026-05-22. After the first 8 outbox events drained successfully, every row in Neon showed `attempts: 0` despite each having been dispatched + processed.
- **Issue:** The `attempts` counter reflects RETRY count, not total dispatch count. First-success rows never touch the counter; only `markFailed` / `markDeadLettered` paths increment it. This is correct behaviour for the DLQ + max-attempts logic (`row.attempts + 1 >= MAX_OUTBOX_ATTEMPTS` is the ceiling check), but the column name + lack of an explicit comment is misleading — a future reader could interpret it as "total dispatches" and write metrics or operator queries against it incorrectly.
- **Recommended fix:** Add a one-paragraph docstring on the `OutboxRepository.markFailed` / `markDeadLettered` methods explaining that `attempts` is retry-count, not dispatch-count. Optionally rename the column to `retryCount` in a future migration if the audit determines the column-name confusion outweighs migration cost.
- **Action:** Cosmetic, M10 hardening. No production exposure; the DLQ + ceiling logic remains correct.

### M-7 [LOW] — Adopt `shopify.app.toml` for app-level config
- **Source:** I-1 fix triage 2026-05-23. Confirmed `shopify.app.toml` does not exist in the repo. GDPR webhook registration was resolved via Partners Dashboard (Option B) for tonight's launch-blocker fix because adopting the toml introduces a workflow shift (Shopify CLI `shopify app config push`, toml-vs-Dashboard precedence rules, config-sync CI integration) that was out of scope for the time-pressured fix window.
- **Issue:** App-level config currently spans multiple uncoordinated surfaces: Partners Dashboard (GDPR compliance webhooks, scopes display, app URL), `.env` (`SHOPIFY_SCOPES`, `SHOPIFY_APP_URL`), `ci.yml` (CI scopes), Render env vars (production scopes). Drift between any two is invisible until install fails. A single version-controlled `shopify.app.toml` with `[webhooks.privacy_compliance]`, `[access_scopes]`, `[auth]` blocks would be the canonical source-of-truth — diffable in PRs, reviewable in audits, drift-detectable via `shopify app config use`.
- **Recommended fix:** post-launch, when bandwidth allows: (a) install Shopify CLI in the devloop, (b) author a minimal `shopify.app.toml` mirroring current Partners Dashboard state, (c) document the `config push` workflow in OPERATIONS.md, (d) integrate `config push` into the CI deploy gate so PRs that change app config also push it to Partners. **Out of scope for v1 launch** — Option B (Partners Dashboard direct edits) is sufficient for App Store submission.
- **Action:** Post-launch M10 hardening. Defer until the v1 launch ramp settles and Shopify CLI workflow can be evaluated without time pressure.

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
