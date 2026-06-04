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

### I-1 [LAUNCH BLOCKER] — GDPR webhook handling (subscribe rejection + probe rejection)
- **✅ Fully resolved 2026-05-23.** Two artifacts, both required for full closure:
  - **Subscribe side: `bc5a61e`** (squash-merge of `c95f88d` on `fix/install-gdpr-webhook-registration`). The install flow's `subscribeAllWebhooks` in `packages/shopify/src/admin/webhook-subscriptions.ts` looped over both `WEBHOOK_TOPIC_TO_EVENT` AND `GDPR_TOPICS` and dispatched every topic via `webhookSubscriptionCreate`. The three GDPR topics (`customers/data_request`, `customers/redact`, `shop/redact`) are NOT valid values for the `WebhookSubscriptionTopic` enum on that mutation — Shopify rejected each with `Variable $topic of type WebhookSubscriptionTopic! was provided invalid value` (prod logs 2026-05-22 20:34 UTC). The receive path treats any per-topic error as terminal (`auth.callback.tsx:168-186` calls `restartFlow`), so the bug bricked the install loop — not silent, fully terminal. Fix: `subscribeAllWebhooks` now loops only over `Object.keys(WEBHOOK_TOPIC_TO_EVENT)` (10 commerce + lifecycle topics); GDPR topics declared at app level (Partners Dashboard). `GDPR_TOPIC_TO_EVENT` + `GDPR_TOPICS` retained for the receive path's `getOutboxEventForTopic` routing to `gdpr.*` outbox events.
  - **Probe side: `e039bcd`** (squash-merge of `1010687` → `f225849` rebased → empty-commit `0cf8c93` for CI retrigger on `fix/webhooks-loader-200-for-compliance-probe`). Discovered during Partners Dashboard configuration when Shopify's Compliance Webhook validation probe hit `GET /webhooks` and the loader returned 405 with body `"webhook endpoint accepts POST only"`. Shopify surfaces that body verbatim as its validation error and refuses to save the URL. Root cause: the original loader's design assumption (`Shopify only sends POST`) was true for webhook DELIVERY but not for compliance VALIDATION probes. Fix: `/webhooks` loader returns 200 OK with body `"webhook endpoint ready (POST to deliver)"` + `Cache-Control: no-store` + `Content-Type: text/plain`, mirroring `healthz.tsx` / `readyz.tsx` pattern. POST `action` handler unchanged — HMAC + ingest path intact. Production verified live: `curl -i https://winback-ai-web.onrender.com/webhooks` → `200 OK` + new body at 2026-05-23 15:08 UTC.
- **Tests:** subscribe side: 5 regression locks in `packages/shopify/tests/webhook-subscriptions.test.ts`. Probe side: 8 regression locks in `apps/web/tests/webhooks-loader.test.ts` (GET → 200, body content, headers, `Allow` header absence, pre-fix 405 string absence, HEAD-synthesis safety, `action` export presence regression lock).
- **Paired operator step (✅ done 2026-05-23):** `shopify.app.toml` linked via `shopify app config link` and edited to add `[webhooks.privacy_compliance]` block with all 3 URLs at `https://winback-ai-web.onrender.com/webhooks`, then pushed to Partners via `shopify app deploy` → released as **`winback-ai-8`**. Same toml push also aligned `[access_scopes]` with the locked 8-scope union from `SHOPIFY-SCOPES-AUDIT.md` (added `read_inventory` which had drifted from Partners-side). See M-7 (resolved) below for the version-controlled-config closure.

### M-7 [LOW] — Adopt `shopify.app.toml` for app-level config
- **Resolved 2026-05-23** on `chore/commit-shopify-app-toml`. `shopify.app.toml` is now the version-controlled source-of-truth for app-level config (client_id, application_url, embedded flag, `[webhooks]` api_version + `[webhooks.privacy_compliance]` URLs, `[access_scopes]`, `[auth]` redirect_urls). Linked from Partners via `shopify app config link`, edited to add the GDPR `[webhooks.privacy_compliance]` block (closes the I-1 operator step) AND align `[access_scopes]` with the 8-scope union locked in `SHOPIFY-SCOPES-AUDIT.md` (the linked-from-Partners toml had only 7 scopes — `read_inventory` had drifted off). Pushed back to Partners via `shopify app deploy` → released as `winback-ai-8`.
- **Going-forward workflow:** edit `shopify.app.toml` locally → `shopify app deploy` → Partners + production deploy follow. Drift between repo + Partners is now diffable (`shopify app config use` then inspect toml). The four other surfaces that previously held scope/app-URL config (`.env`, `apps/web/.env`, `ci.yml`, Render env vars) remain — they're code-side / process-side concerns, not app-config — but the toml is the canonical declaration for anything Shopify accepts via Partners.
- **Out of scope for this commit:** integrating `shopify app deploy` into CI (deferred — needs Partners CLI service-account auth in CI which we haven't provisioned). For now, deploys are local-CLI from operator's machine; OPERATIONS.md §4 captures the workflow.

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

### Q-H1 [LOW] — Un-enriched-currency 'USD' fallback observability + conditional hard-block follow-up
- **Source:** Q-H1 closure pass (`feat/merchant-currency-at-install` branch). Surfaced during a re-audit of the stale "POINTS-TO-CONSIDER follow-up" comments in `apps/drainer/src/handlers/customer-state-changed.ts:323-327` + `packages/db/src/services/customer-score.service.ts:127-130`.
- **Status:** Currency enrichment IS implemented. Two existing mechanisms persist `Merchant.currency` from Shopify:
  - **D2 — `handleMerchantInstalled`** (`apps/drainer/src/handlers/merchant.ts:70`) calls `enrichInstall` immediately when the `merchant.installed` outbox event drains. Runs out-of-tx (MARK_BEFORE_INVOKE) so it completes within seconds of OAuth callback on the happy path.
  - **D3 — `runEnrichmentSweep`** (`apps/scheduler/src/handlers/enrichment-sweep.ts`) every 15 min, retries `enrichInstall` for merchants with `shopDetailsFetchedAt IS NULL AND installedAt < NOW() - INTERVAL '10 minutes'`. Self-heals D2 failures.
- **Remaining footgun (rare failure window):** if D2's `enrichInstall` call fails (network, Shopify hiccup, scope issue) AND a `customer.state_changed` event fires before D3 catches up (>10 minutes after install), the AI prompt + the `CustomerScore.currency` snapshot fall back to `'USD'` regardless of the merchant's actual shop currency. For a non-US merchant in the failure window: prompts say "USD 199.95" when they should say "EUR 199.95" / etc.
- **Observability shipped (this entry's closing commit):** both fallback paths now emit `log.warn` with full operator context:
  ```
  {
    merchantId, shop, installedAt (ISO),
    shopDetailsFetchedAt (null on the failure path),
    eventTrigger: 'customer.state_changed' | 'scoring',
    timeSinceInstallMs: Date.now() - installedAt
  }
  ```
  The `timeSinceInstallMs` field lets operators distinguish:
  - `< 10 * 60_000` (10 min): normal install window, D3 hasn't tried yet — no action needed.
  - `>= 10 * 60_000` (10 min): D3 sweep has tried at least once and failed → operator investigates the merchant manually (run `enrichInstall` directly or check Shopify Admin API health for the shop).
- **Trigger condition for M10 hard-block (this entry's open task):** if these WARN logs appear in production with `timeSinceInstallMs >= 600_000` (>10 min) at any non-trivial rate (say, more than 1 per week per active merchant cohort), implement the hard-block — replace the USD fallback with an early-return in both handlers (AI generation skipped; scoring skipped) until `Merchant.currency` is populated. Trade-off: never wrong currency vs sometimes no message for un-enriched merchants. Acceptable trade if WARN logs prove this happens regularly; over-engineered if they stay quiet.
- **Action:** ship the WARN log observability now (this PR). Watch logs post-launch. Implement the hard-block ONLY if the trigger condition above fires. The conditional approach avoids over-engineering for an edge case that may never materialize at scale.

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

## 🔒 M11.x — pnpm.overrides discipline + Dependabot's blind spot

The override sweep of 2026-06-01 closed a class of bugs Dependabot cannot see. This section codifies the policy + workflow that prevents the class from returning, and inventories the current state of `pnpm.overrides` so future-us can find the deferred upgrade work without grepping commit history.

### What this section is NOT
- NOT a comprehensive dependency strategy doc. The per-block comments in `.github/dependabot.yml` remain the source-of-truth for *why* each ignore exists.
- NOT a coupled-upgrade plan. Unfreezing Chain A or Chain B (see below) is its own dedicated session, not a deliverable of this entry.

### Why this exists
PR #66 (a Dependabot `npm-minor-and-patch` group) bumped `@anthropic-ai/sdk` from `0.65.0` to `0.100.1` in `packages/ai/package.json`. The bump merged green. The `pnpm.overrides` entry for `@anthropic-ai/sdk` stayed at `0.65.0`. `pnpm install` then resolved `@anthropic-ai/sdk` to **`0.65.0`** — the override's pinned version, not the bumped per-package version. The "merged" PR was a runtime no-op invisible to anyone reading the lockfile (the lockfile correctly recorded the override's resolution; nothing distinguished "override won" from "per-package and override agreed"). Caught only because the 2026-06-01 sweep audited every override against every per-package declaration.

### The bug class
`pnpm.overrides` is a workspace-root authority that pins a version regardless of what any per-package declaration says. It exists for legitimate reasons (security pins, transitive deduplication, coupling enforcement). Dependabot:

- **CAN** propose bumps to per-package `dependencies` / `devDependencies` / `peerDependencies` entries.
- **CANNOT** read or modify `pnpm.overrides`. It doesn't parse the `pnpm` key in `package.json`.

The silent-no-op pattern: per-package gets bumped to N, override stays at M, lockfile resolves to M, "merged" Dependabot PR has zero runtime effect. There is no warning, no surface in `pnpm install` output, no diff in the lockfile that distinguishes the two outcomes. Detection requires explicitly comparing the two declarations — the job of the STEP F CI guardrail.

### The CI guardrail (STEP F, `d57675a`)
`scripts/check-override-alignment.mjs` walks root + every workspace `package.json`, and for each `pnpm.overrides` entry compares against every per-package declaration in `dependencies` / `devDependencies` / `peerDependencies`. Strict exact-string equality: ranges (`^x.y.z`) in a per-package declaration against an exact override are FAIL.

- Local: `pnpm lint:overrides`
- Tests: `pnpm test:overrides` (12 cases via `node:test`, zero new deps)
- CI: separate workflow step `Check pnpm.overrides alignment` runs immediately after `actions/checkout@v4`, before `pnpm/action-setup@v3` — drift fails the workflow in ~5 seconds, before the ~60s install + ~90s build would otherwise burn.

### How to bump a pinned package (the M11.x sync pattern)

1. **Decide the target version.** Verify the upstream changelog for breaking changes. For coupled packages, verify the whole chain moves together (see Chain A / Chain B below).
2. **Edit in ONE coupled commit:** root `pnpm.overrides` + EVERY per-package `dependencies` / `devDependencies` / `peerDependencies` declaration of the same key, anywhere in the workspace. Dependabot CANNOT produce this commit shape — you produce it by hand.
3. **`pnpm install`** to refresh the lockfile; include the lockfile in the same commit.
4. **Verify** via the load-bearing gate: `pnpm drainer:test` for AI / data / schema packages; `pnpm -r test` (unit baseline) for everything else.

After `d57675a` (STEP F CI guardrail) is live on main, a per-package bump WITHOUT a corresponding override sync will FAIL CI at `lint:overrides` BEFORE `pnpm install` runs. This is the contract the guardrail enforces — you cannot accidentally create another PR #66 silent no-op.

Reference exemplars (override + per-package + lockfile in one commit): `7266138` (`@anthropic-ai/sdk`), `1393448` (`openai`), `21b7963` (`zod`).

### Current pin inventory (as of 2026-06-02, main @ `d57675a`)

| Package | Pinned | Status | Last action | Commit |
|---|---|---|---|---|
| `@anthropic-ai/sdk` | `0.100.1` | BUMPed | sync 0.65.0 → 0.100.1 | `7266138` |
| `openai` | `6.39.1` | BUMPed | sync 4.104.0 → 6.39.1 | `1393448` |
| `zod` | `4.4.3` | BUMPed | sync 3.25.76 → 4.4.3 | `21b7963` |
| `vitest` | `2.1.9` | KEEP+IGNORE | sequencing freeze; dedicated v4 migration session deferred | `3397493` |
| `@shopify/shopify-api` | `11.14.1` | KEEP+IGNORE | coupled chain (Chain B) | `abe6415` |
| `@shopify/shopify-app-remix` | `3.8.1` | KEEP+IGNORE | coupled chain (Chain B) | `abe6415` |
| `@shopify/shopify-app-session-storage` | `3.0.20` | KEEP+IGNORE | coupled chain (Chain B) | `abe6415` |
| `@shopify/shopify-app-session-storage-prisma` | `5.2.3` | KEEP+IGNORE | coupled chain (Chain B) | `abe6415` |
| `prisma` | `5.22.0` | KEEP+IGNORE | preventive freeze (Chain B) | `a7a874a` |
| `@prisma/client` | `5.22.0` | KEEP+IGNORE | preventive freeze (Chain B) | `a7a874a` |

The 3 BUMPed packages are NOT in `.github/dependabot.yml`'s ignore block — Dependabot continues proposing minor/patch updates for them. The 7 KEEP+IGNORE packages each have a matching ignore entry. The 13-entry ignore list also covers `ioredis` + 4 React-family packages + `vite` that are NOT pinned via overrides (see Chain A and the vite cross-cutting freeze below). STEP G verified the initial 12-entry / 5-comment-block consolidation; the `vite` freeze (confirmed 2026-06-02 against PR #77) adds a 13th entry under its own 6th comment block.

### Deferred coupled-upgrade chains

Two upgrade chains are deliberately frozen. They are NOT planned work for any current session; unfreezing either is its own multi-session effort.

**Chain A — React 19 + Polaris 14 + Remix 3**

- Polaris 13.9.5 pins `react ^18.0.0` in its peerDep.
- `@remix-run/react@2.17.4` pins `react ^18.0.0` in its peerDep.
- Bumping React alone crashes `react-dom@18` at module load (React 19 removed the private internals `react-dom@18` reads).
- Frozen packages: `react`, `react-dom`, `@types/react`, `@types/react-dom`, `@shopify/polaris`, the `@remix-run/*` family.
- Unfreezing requires a dedicated session including the Polaris 13 → 14 migration audit (`POST-EPIC-F-CONSCIOUS-DECISION.md` §11 item 11.10).

**Chain B — Shopify family + Prisma 6**

Chain B **has Chain A as a precondition** (cannot proceed until Chain A clears) AND **additionally requires Prisma 6** migration. The dependency direction is one-way: Chain A can be unfrozen without Chain B; Chain B cannot be unfrozen without Chain A.

- `@shopify/shopify-app-remix@4.x` transitively requires React 19 via `@remix-run/react@2.17.4+`'s peerDep → blocked by Chain A.
- `@shopify/shopify-app-session-storage-prisma@9.x` pins `@prisma/client + prisma ^6.19.0` → adds the Prisma 5 → 6 driver-adapter migration on top of the Shopify-family bump.
- Frozen packages: `@shopify/shopify-api`, `@shopify/shopify-app-remix`, `@shopify/shopify-app-session-storage`, `@shopify/shopify-app-session-storage-prisma`, `prisma`, `@prisma/client`.
- Unfreezing requires Chain A complete + a dedicated session for Prisma 5 → 6. Cross-references: `.github/dependabot.yml` comment blocks (Shopify family + Prisma family) for the full coupling map; commits `abe6415` + `a7a874a` for the original freeze rationale.

**Cross-cutting freeze — `vite`** (added 2026-06-02 after PR #77 triage). Vite is the build infra for both Remix (`apps/web`) and every `vitest.config.ts` across the workspace, so it is blocked by **two independent freezes simultaneously**: (1) `vitest@2.1.9` hard-depends on `vite ^5.0.0` (the vitest freeze; commit `3397493`); (2) `@remix-run/dev@2.15`'s vite peerDep `^5.1.0` (Chain A's Remix half; commit `154c3d2`). A Node engine bump is also required (vite 8 needs Node ≥20.19.0; CI runs 20.11.0). See `.github/dependabot.yml`'s vite block for the four-blocker map; unfreezing folds into the vitest + Chain-A sessions.

### Workflow rules (locked 2026-06-01)

These rules are non-negotiable for any future override / dependency / multi-package work.

1. **Click GitHub's "Rebase and merge" button. Never local rebase+push to main.** The PR is the audit artifact; local rebase + push bypasses the audit trail and breaks the merge button. (Locked after the PR #63 incident.)
2. **`pnpm.overrides` bumps require coupled commits.** Override + every per-package declaration + lockfile in ONE commit. Dependabot cannot couple these; the human-led M11.x sync pattern is the substitute. STEP F's `lint:overrides` enforces this at CI time.
3. **Per-step audit gate non-negotiable.** Phase 1 surface (data) → user verdict → Phase 2 execute → Phase 3 verify → commit. No batching multiple packages into one Phase 2; structural coupling (e.g. the Shopify family decision) is the only exception, and even there each package is audited as its own Phase 1 first.
4. **Drainer integration suite is the LOAD-BEARING runtime gate for AI / data / schema package bumps.** Unit tests don't exercise real Postgres + schema validation on fixture payloads + an AI worker exercising the SDK. Integration does. Used as the gate for the `@anthropic-ai/sdk`, `openai`, and `zod` sync commits.
5. **Empirical resolution beats documentation audit when feasible.** Zod 4's Phase 1 estimated ~25–35 lines of mechanical migration; Phase 2 proved zero (v3 idioms ship as functional aliases in v4). Run the test matrix before assuming the documented "deprecated" needs immediate refactor.
6. **After any major-version dep bump that changes inferred-type shapes, run `tsc -b --clean` in-session.** `tsc -b`'s incremental cache stores resolved-type metadata that does not invalidate cleanly across a dep's major-version boundary when inferred-type shapes change (e.g., zod 3→4 introduces `z.core.$strip` and re-shapes `z.ZodDiscriminatedUnion`). Symptom: downstream consumers see properly-typed exports collapse to `unknown` on incremental builds; a clean rebuild produces correct types. Discovered B6 session 2026-06-04 across the M11.x sweep's zod 3.25.76 → 4.4.3 sync. CI is unaffected — `actions/checkout@v4` starts fresh and `actions/setup-node`'s pnpm cache is keyed on the lockfile, not on tsbuildinfo (see .github/workflows/ci.yml). This is purely a local-dev cache hazard.

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
