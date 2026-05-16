# Pre-D2 Audit Report
**Date:** 2026-05-16  
**Auditor:** Senior Dev session  
**Commit baseline:** 5e92cf0 (D1 complete)  
**Scope:** All uncommitted changes in main checkout pending sign-off before D2 begins

---

## Files Audited

| File | Location | Result |
|---|---|---|
| docker-compose.dev.yml | repo root | ✅ PASS |
| vite.config.ts | apps/web | ✅ PASS |
| config.ts | packages/shopify/src | ✅ PASS |
| shopify.server.ts | apps/web/app | ✅ PASS |
| root.tsx | apps/web/app | ✅ PASS |
| _index.tsx | apps/web/app/routes | ✅ PASS |
| customers.tsx | apps/web/app/routes | ✅ PASS |
| campaigns.tsx | apps/web/app/routes | ✅ PASS |
| settings.tsx | apps/web/app/routes | ✅ PASS |
| tenant-scope.ts | packages/db/src | ✅ PASS |
| audit-scope.ts | packages/db/src | ✅ PASS |
| gdpr-processor.ts | packages/db/src/compliance | ❌ 7 BROKEN SITES |

---

## Pending Commits (3 logical groups)

### Commit 1 — Dev infra
**Files:** `docker-compose.dev.yml`, `package.json` (db:dev:up/down scripts), `.env.example` REDIS_URL port fix

**Findings:** Clean. Postgres-only dev compose on port 5432, correctly isolated from test compose (port 5433). Redis intentionally omitted with clear comment explaining shared test container. Healthcheck correct.

**Verdict: ✅ Ready to commit**

---

### Commit 2 — ALS fix + API version + HMR hardening
**Files:** `.env.example`, `shopify.server.ts`, `packages/shopify/src/config.ts` (2025-01 → 2026-04), `apps/web/app/routes/_index.tsx` (ALS fix), `packages/db/src/tenant-scope.ts`, `packages/db/src/audit-scope.ts` (globalThis hoist), `packages/db/src/compliance/gdpr-processor.ts` (7 ALS sites fixed — see sub-detail below)

**Findings:**

- `config.ts` — Version regex `^\d{4}-\d{2}$` correct. Single-key encryption with honest rotation comment. No direct `process.env` reads. ✅
- `shopify.server.ts` — `shopifyApp({sessionStorage})` only. Locked pattern preserved. `resolveApiVersion` fallback safe. `authenticate.admin` / `authenticate.webhook` not used. ✅
- `_index.tsx` — ALS fix already applied. Async callback + explicit await inside `withSystemScope`. Comment documenting the broken pattern is excellent and should stay. ✅
- `tenant-scope.ts` — `globalThis.__winbackScopeStore` hoist correct. `withSystemScope` and `withTenantScope` both typed `() => Promise<T>` — type signature rejects sync callbacks at compile time. Runtime regex belt-and-suspenders intact. ✅
- `audit-scope.ts` — `globalThis.__winbackAuditStore` hoist correct. Same pattern as tenant-scope. ✅
- `gdpr-processor.ts` — 7 sync-callback ALS sites converted to async + explicit await. Same bug class and fix pattern as `_index.tsx`. Per-site detail in the "Commit 2 sub-detail" section below. ✅

**Registry check (resolved):** `SYSTEM_SCOPE_REASONS.web.index_lookup` confirmed present at `packages/contracts/src/system-scope-reasons.ts:84`, wired into both `ALL_SYSTEM_SCOPE_REASONS` (runtime set, line 107) and the `SystemScopeReason` union type (line 98). No build failure risk.

**Verdict: ✅ Ready to commit**

---

### Commit 3 — Pre-D2 UI shell
**Files:** `design.md`, `root.tsx`, `customers.tsx`, `campaigns.tsx`, `settings.tsx`, `app-bridge.d.ts`, `vite.config.ts`

**Findings:**

- `root.tsx` — `<ui-nav-menu>` pattern correct for App Bridge embedded nav. `Frame` wrapper correct for Polaris toast/modal slots. `getShopifyConfig()` in loader is acceptable (API key is public). App Bridge CDN script tag is the correct pattern for this SDK version. ✅
- `_index.tsx` — Polaris 13 compliant. `Layout.Section variant="oneHalf"` correct (not the removed `Layout.TwoColumns`). Empty-state cards honest — no fake `$0` metrics. Epic labels accurate. ✅
- `customers.tsx` — Static placeholder, no loader, correct per design.md policy ("Tests on loader routes only"). Honest empty-state copy. ✅
- `campaigns.tsx` — Same as customers.tsx. ✅
- `settings.tsx` — ALS fix applied (both `withSystemScope` and `withTenantScope` use async callbacks). `BigInt` serialized to string at JSON boundary — correct. Read-only with honest "edit arrives at M10" copy. ✅
- `vite.config.ts` — `allowedHosts` covers all three tunnel providers (ngrok-free.dev, ngrok-free.app, trycloudflare.com). `host: 0.0.0.0` correct for tunnel access. ✅

**Verdict: ✅ Ready to commit**

---

## Commit 2 sub-detail — gdpr-processor.ts ALS fix

**File:** `packages/db/src/compliance/gdpr-processor.ts`  
**Scope:** 7 sync-callback ALS sites, all the same bug class as the `_index.tsx` / `settings.tsx` fix. Folded into Commit 2 so every ALS-callback fix in the repo lands in one archaeological commit ("this is where the sync-callback ALS bug was eradicated repo-wide").

### The broken pattern
```ts
// BROKEN — sync arrow returns PrismaPromise before ALS.run() exits.
// By the time Prisma extension hook fires, ALS store is gone → TenantScopeError.
withTenantScope(merchantId, () => uow.run(async (ctx) => { ... }))
withSystemScope(REASON, () => repo.method(...))
```

### The fix pattern
```ts
// CORRECT — async callback keeps ALS.run() open across the await boundary.
withTenantScope(merchantId, async () => { await uow.run(async (ctx) => { ... }) })
withSystemScope(REASON, async () => { await repo.method(...) })
```

### Why unit tests don't catch this
Mocked Prisma promises resolve synchronously. ALS context never has to survive a real microtask boundary. The bug only surfaces against real Prisma in D2's outbox drainer.

### Why this is D2-blocking
D2's outbox drainer routes `gdpr.*` OutboxEvents to these handlers. Without the fix, every `customers/redact` and `shop/redact` webhook would throw `TenantScopeError` the moment D2 ships. Bundled into Commit 2 (the ALS-fix archaeology commit), so D2 step 1 can proceed immediately after Commit 2 lands.

### All 7 broken sites

| Line | Function | Broken call |
|---|---|---|
| 126 | `processCustomerDataRequest` | `withTenantScope(merchantId, () => uow.run(...))` |
| 188 | `processCustomerRedact` — malformed branch | `withTenantScope(merchantId, () => auditLog.append(...))` |
| 206 | `processCustomerRedact` — main branch | `withTenantScope(merchantId, () => uow.run(...))` |
| 348 | `processShopRedact` — merchant lookup | `withSystemScope(REASON, () => merchantRepo.findByShop(...))` |
| 355 | `processShopRedact` — idempotent tombstone | `withSystemScope(REASON, () => auditLog.append(...))` |
| 372 | `processShopRedact` — audit-first | `withTenantScope(merchantId, () => new UnitOfWork(prisma).run(...))` |
| 408 | `processShopRedact` — final hard delete | `withSystemScope(REASON, () => merchantRepo.hardDelete(...))` |

### Already correct (do not touch)
| Line | Function | Status |
|---|---|---|
| 401–403 | `processShopRedact` — Session deleteMany | ✅ async callback, already correct |
| 435 | `chunkedDeleteTenant` — idempotencyKey branch | ✅ async callback, already correct |
| 473 | `chunkedDeleteTenant` — 1:1 tables branch | ✅ async callback, already correct |
| 488 | `chunkedDeleteTenant` — multi-row branch | ✅ async callback, already correct |

---

## Commit Order

1. **Commit 1** — Dev infra (docker-compose.dev.yml, package.json scripts, .env.example)
2. **Commit 2** — ALS fix + API version + HMR hardening (config, shopify.server, _index, tenant-scope, audit-scope, gdpr-processor — all 7 sites)
3. **Commit 3** — Pre-D2 UI shell (root, customers, campaigns, settings, vite.config, design.md, app-bridge.d.ts)

Then D2 begins: first task is `subscribeAllWebhooks` wiring (closes B1).

---

## Standing Rules Verified

- [x] No direct `process.env` reads outside `@winback/config`
- [x] `shopifyApp({sessionStorage})` only — no `authenticate.admin/webhook`
- [x] AuditLog writes via `AuditLogRepository.append` only
- [x] Polaris 13 API used correctly (`Layout.Section variant` not removed `TwoColumns`)
- [x] BigInt serialized at JSON boundary
- [x] No fake metrics in UI
- [x] Tunnel allowedHosts covers all providers (ngrok is active tunnel)
- [x] globalThis hoist on both ALS instances
