# OPERATIONS.md — operator runbook for the AI Customer Winback app

This doc is the **operator's playbook** — the commands, sequences, and decision rules for running the production app. It is NOT architectural ("why we built it this way") or strategic ("what to build next"). For those:

- `ARCHITECTURE.md` — locked policies and their rationale
- `EPIC-F-DESIGN.md` / `POST-EPIC-F-CONSCIOUS-DECISION.md` / `CP2-ATTRIBUTION-CONTRACT.md` — design contracts
- `handoff.md` — live state + next-task pointer
- `POINTS-TO-CONSIDER.md` — open hardening items + resolved register

This doc captures only what you need to **do** at the keyboard. Update it in the same commit as any operational change.

---

## Production stack at a glance

| Layer | Provider | Region | Free tier? | Notes |
|---|---|---|---|---|
| Web service | Render | Singapore | Web Starter $7/mo (no sleep) | `winback-ai-web`. Handles OAuth, webhooks, embedded admin. |
| Drainer | Render Background Worker | Singapore | $7/mo | `winback-ai-drainer`. BullMQ worker on `outbox.drain`. |
| Scheduler | Render Background Worker | Singapore | $7/mo | `winback-ai-scheduler`. BullMQ repeatable `cron.rollup` + `cron.sweep`. |
| Postgres | Neon | AWS Asia Pacific (Singapore) — `aws-ap-southeast-1` | 3 GB free | Project `winback-ai`, database `neondb`. Pooled connection (PgBouncer transparent). |
| Redis | Upstash | Singapore | 10K cmds/day free | TLS-only (`rediss://`). |
| LLM | DeepSeek | — | Pay-as-you-go | Provider locked per V7 (`POST-EPIC-F-CONSCIOUS-DECISION.md`). Switch = margin re-baseline. |
| Shopify app config | Shopify Partners dev dashboard | — | — | Versioned. Current live version: `0.4` (or higher) with 8-scope union. |

**Monthly cost floor at design-partner scale:** ~$21/mo (3× Render Starter) + $0 external + DeepSeek API at ~$0.30–$5/mo. See `PRICING-MODEL-v1.md` for unit-econ math.

---

## §1 — Migration Deploy Playbook

The canonical sequence for shipping a Prisma migration to live Neon production.

### Rule: always migrate AFTER merge to main. Never before.

`main` is the canonical state of the repo. Migration files on `main` describe the schema production should match. Migrating Neon before merging puts production schema **ahead of** what `main` claims it should be — drift-check fails, rollback semantics get tangled, and reviewers can't see what's in prod versus what was approved.

**Apply this rule to every migration. No exceptions.** Even trivial additive DDL (P-1's `ALTER COLUMN SET DEFAULT` was as trivial as it gets — still applied after merge).

### Sequence B — the canonical migration deploy flow

1. **Local dev:** edit `packages/db/prisma/schema.prisma`, run `pnpm --filter @winback/db exec prisma migrate dev --create-only --name <descriptive_name>` to generate the migration file.
   - **If shadow DB unavailable** (current state, see `POINTS-TO-CONSIDER.md` M-5): hand-author the migration SQL at `packages/db/prisma/migrations/<ts>_<descriptive_name>/migration.sql`. Mirror what `prisma migrate diff --script` would emit — alphabetical or schema-declaration statement order, `CURRENT_TIMESTAMP` literal (not `now()` or `NOW()`), one statement per line, blank-line separation, EOF newline. Drift-check noise risk grows with hand-authoring frequency; resolve M-5 to stop relying on this.
2. **Local verification — fresh-from-zero apply:**
   ```powershell
   pnpm db:test:down              # destroys the test container's data volume
   pnpm db:test                   # spins up fresh Postgres, applies ALL migrations from zero, runs db int tests
   ```
   The `Volume ... Removed` line in `db:test:down`'s output confirms the volume was destroyed; the subsequent `db:test` applies all migrations starting from a clean DB. This is the standard for "did the migration apply cleanly" verification.
3. **Commit + push + PR.** CI runs `prisma migrate deploy` against a fresh Postgres service container — second confirmation the migration applies clean.
4. **Audit-gate:** surface the migration SQL + schema diff for review. Specifically verify:
   - Statement order is deterministic (alphabetical OR schema-declaration; not random)
   - SQL keyword spelling matches Postgres convention (`CURRENT_TIMESTAMP` not `now()` for defaults; `ON DELETE CASCADE` not `on delete cascade`)
   - No accidental schema files in `migrations/` (only `migration.sql` and optional `rollback.sql` per migration dir)
   - `migration_lock.toml` unchanged (it's `provider = "postgresql"`, never edit)
5. **Merge to main.**
6. **Sync local main + apply to Neon:**
   ```powershell
   git checkout main
   git pull --ff-only origin main
   $env:DATABASE_URL = "<neon pooled connection string, /neondb at end>"
   pnpm --filter @winback/db exec prisma migrate deploy
   ```
   Expected output: `Applying migration `<ts>_<name>`` followed by `All migrations have been successfully applied.`
7. **Verify via Neon MCP** (or psql / Neon SQL Editor). For column-default changes:
   ```sql
   SELECT table_name, column_name, column_default,
          CASE WHEN column_default ILIKE '%now()%' OR column_default ILIKE '%current_timestamp%' THEN 'OK'
               ELSE 'CHECK' END AS status
   FROM information_schema.columns
   WHERE column_name = '<the column>'
   ORDER BY table_name;
   ```
   Postgres versions render defaults differently (`CURRENT_TIMESTAMP`, `now()`, `('now'::text)::timestamp without time zone` — all semantically equivalent). The `ILIKE '%now()%' OR ILIKE '%current_timestamp%'` predicate is version-tolerant.
8. **Smoke test:** trigger one end-to-end action that exercises the changed surface (a webhook for a schema change touching webhook tables, an install for a schema change touching Session/Merchant, etc.). For changes that Prisma client mediates (the common case), the smoke test confirms the app starts cleanly + writes succeed.
9. **Follow-up commit:** flip the resolved item in `POINTS-TO-CONSIDER.md` with the merge SHA; add any new M10 items discovered during the work.

### What to do if `prisma migrate deploy` against Neon fails

| Failure mode | Recovery |
|---|---|
| Connection error (P1001 — "can't reach database server") | DATABASE_URL is malformed or pointing at the wrong host. Verify the pooled hostname has `-pooler` in it; verify `?sslmode=require&channel_binding=require` is intact; re-export and retry. |
| Migration applied partially (one statement succeeded, another failed) | Postgres runs migrations in a single tx by default — partial-apply shouldn't happen. If it did (e.g. tx-disabled migration like `CREATE INDEX CONCURRENTLY`), connect via psql, manually fix the schema state, then `UPDATE _prisma_migrations SET finished_at = NOW(), applied_steps_count = <real-count> WHERE migration_name = '<name>'`. Document the recovery in the commit message. |
| "migration history conflicts" (P3009) | Someone applied a migration to Neon out of band, or main has been rebased after a migration was applied. Compare `SELECT migration_name FROM _prisma_migrations ORDER BY started_at` against `ls packages/db/prisma/migrations/`. If a migration exists in Neon but not in main → recovery is to add the migration file to main (out-of-order apply is acceptable for additive changes). If a migration exists in main but not in Neon → re-run `migrate deploy`. |
| "migration found in resolved state" (P3018) | Previous failed apply left the row marked failed. Run `prisma migrate resolve --applied <migration_name>` if the schema is actually in the post-migration state, OR `--rolled-back <migration_name>` if you've manually reverted. |

### What "trivial" looks like (safe to hand-author per M-5)

- `ALTER COLUMN ... SET DEFAULT <constant>`
- `CREATE INDEX <name> ON <table>(<columns>)`
- `ADD COLUMN <name> <type>` (nullable, no default)
- `DROP INDEX <name>` (paired with `CREATE INDEX` in another migration)

### What is NOT trivial (do NOT hand-author; resolve M-5 first OR verify against Prisma-emitted SQL via a Neon branch)

- Renames (column or table)
- Type changes (especially with `USING` clauses)
- Constraint changes that interact with existing data
- Multi-table operations with FK ordering implications
- Data backfills (`UPDATE … FROM …`, `INSERT … SELECT`)
- Anything touching `_prisma_migrations` directly

---

## §2 — Render Deploy Playbook

### Service inventory

| Service | Render type | Start command | Build command | Notes |
|---|---|---|---|---|
| `winback-ai-web` | Web Service Starter | `pnpm --filter @winback/web start` | see below | Public HTTPS at `https://winback-ai-web.onrender.com`. |
| `winback-ai-drainer` | Background Worker Starter | `pnpm --filter @winback/drainer-app start` | see below | No HTTP. BullMQ worker on `outbox.drain`. |
| `winback-ai-scheduler` | Background Worker Starter | `pnpm --filter @winback/scheduler-app start` | see below | No HTTP. BullMQ repeatable jobs (`cron.rollup`, `cron.sweep`). |

### Build command shape

**For `winback-ai-web` (the only service that needs the Remix Vite build):**

```
corepack enable && pnpm install --frozen-lockfile --prod=false && pnpm --filter @winback/db prisma:generate && pnpm build && pnpm --filter @winback/web build
```

**For `winback-ai-drainer` and `winback-ai-scheduler`:**

```
corepack enable && pnpm install --frozen-lockfile --prod=false && pnpm --filter @winback/db prisma:generate && pnpm build
```

### Why each token in the build command exists

| Token | Why |
|---|---|
| `corepack enable` | Render's Node runtime ships pnpm via corepack; without enabling, `pnpm` isn't on PATH. |
| `pnpm install --frozen-lockfile` | Standard. Forces install from the committed lockfile. |
| `--prod=false` | Critical. Render sets `NODE_ENV=production` via the env var, which makes pnpm skip devDependencies. Prisma CLI lives in devDependencies; without `--prod=false`, `packages/db`'s postinstall script can't run `prisma generate` and the build fails. |
| `pnpm --filter @winback/db prisma:generate` | Pre-generates the Prisma client before the TypeScript build needs it. Without this, the import of `@prisma/client` fails at build time. |
| `pnpm build` | Workspace-root `tsc -b`. Builds all TypeScript composite project references. |
| `pnpm --filter @winback/web build` | Only for the web service: runs `remix vite:build` to produce `apps/web/build/server/index.js` which `remix-serve` consumes at runtime. The drainer + scheduler don't have a Vite build, so this step is omitted for them. |

### Env-var register

**Shared across all 3 services** (use Render Environment Groups to define once, attach to all three):

| Key | Type | Example / notes |
|---|---|---|
| `NODE_ENV` | plain | `production` |
| `LOG_LEVEL` | plain | `info` |
| `SHOPIFY_API_KEY` | secret | from Partners → Settings → Client credentials → Client ID |
| `SHOPIFY_API_SECRET` | secret | from Partners → Settings → Client credentials → Client secret |
| `SHOPIFY_APP_URL` | plain | `https://winback-ai-web.onrender.com` (exactly; no trailing slash) |
| `SHOPIFY_SCOPES` | plain | `read_customers,read_orders,read_products,read_inventory,read_price_rules,write_discounts,write_marketing_events,read_marketing_events` |
| `SHOPIFY_API_VERSION` | plain | `2026-04` |
| `ENCRYPTION_KEY` | secret | 44-char base64 (32 bytes). `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **MUST match across all 3 services** or sessions encrypted by one can't be decrypted by another. |
| `DATABASE_URL` | secret | Neon pooled string, ends `/neondb?sslmode=require&channel_binding=require` |
| `REDIS_URL` | secret | Upstash `rediss://...` (TLS, double-s) |
| `AI_PROVIDER` | plain | `deepseek` (V7 locked) |
| `AI_MODEL` | plain | `deepseek-v4-flash` (V7 locked) |
| `AI_MAX_TOKENS` | plain | `300` |
| `AI_TEMPERATURE` | plain | `0.7` |
| `DEEPSEEK_API_KEY` | secret | from platform.deepseek.com → API Keys |

**Per-service override:**

| Key | `winback-ai-web` | `winback-ai-drainer` | `winback-ai-scheduler` |
|---|---|---|---|
| `SERVICE_NAME` | `web` | `worker.drainer` | `worker.scheduler` |

Render env vars are masked by default in dashboard + logs. No need to toggle a "secret" flag (Render doesn't have one separate from the env var entry itself).

### Health check

`winback-ai-web` only. Default Render health check hits `HEAD /`. The `/_index` route correctly returns 400 for requests without `?shop=xxx&host=xxx` query params — Render interprets this as unhealthy + may cycle the container.

**Mitigation:** Render dashboard → `winback-ai-web` → **Settings** → **Health Check Path** → set to **empty/blank** (disables health checks). The service stays up regardless; webhook ingest reliability is what matters, and webhooks don't depend on health-check status.

Future: add a dedicated `/healthz` route that returns 200 with a DB ping. That can become the health check path. Not yet implemented.

### Known Render-specific gotchas (with their resolutions)

| Gotcha | Resolution |
|---|---|
| Build fails: `sh: 1: prisma: not found` (postinstall) | Build command missing `--prod=false`. See above. |
| Runtime fails: `ENOENT ... apps/web/build/server/index.js` | Build command missing `pnpm --filter @winback/web build`. Remix Vite build is separate from `tsc -b`. |
| Runtime fails: ConfigError on boot | One of the boot-validated env vars (SHOPIFY_*, ENCRYPTION_KEY, DATABASE_URL, REDIS_URL, AI_*) is missing or malformed. Error message names the offending key. |
| Sessions encrypted by web can't be decrypted by drainer | `ENCRYPTION_KEY` differs across services. Use Render Environment Groups so all 3 services share the same value. |
| Web service URL doesn't match SHOPIFY_APP_URL | Render assigned a different subdomain than expected. Edit `SHOPIFY_APP_URL` env var to match the actual Render URL; also update Partners dashboard App URL to match. |
| OAuth install loops forever with `missing_cookie` in logs | State cookie's `SameSite` attribute is wrong for embedded-app iframe context. Must be `SameSite=None` (with `Secure`). Resolved in `apps/web/app/services/auth-state.server.ts`. |
| Database connection times out at scale (10+ concurrent connections) | `DATABASE_URL` is the direct (non-pooled) connection. Switch to the `-pooler` hostname variant. Not an immediate-tier problem at design-partner scale (1–5 merchants); becomes load-bearing at ~50+ merchants. Fix before launch regardless. |

### Free-tier traps avoided

- **Vercel Hobby commercial-use ToS** — Vercel's Hobby plan technically restricts commercial use; Shopify apps charging merchants are commercial. We chose Render (paid Starter from day one) to avoid this gray-area.
- **Render free Web Service sleep** — free tier sleeps after 15 min idle. Webhook ingest endpoints can't sleep (Shopify retries with backoff; ack-budget is 5 sec). Use Starter ($7/mo) from go-live.
- **Neon Postgres free 90-day expiry** — Neon's free tier doesn't expire for development databases (it's "always free"). Some legacy docs mention a 90-day window; that applies to Render's own managed Postgres, which we don't use.

---

## §3 — Incident Recovery Playbook

### Web service returns 502 / Application Error

1. Render dashboard → `winback-ai-web` → **Logs** tab.
2. Look for the most recent error before the 502. Common patterns:
   - `ConfigError: Invalid configuration` — env var missing/malformed; check **Environment** tab.
   - `TypeError: Cannot read properties of undefined` — code regression; recent merge introduced a bug. `git log` on main + `git revert` if needed.
   - `PrismaClientInitializationError` — DATABASE_URL broken; verify Neon is reachable + the connection string ends with `/neondb?...`.
3. If logs show no error and the service is just Restarting/Crashing — check **Events** tab for OOM events. Memory ceiling on Starter is 512 MB; some Remix builds get close. Solution: upgrade to Standard ($25/mo) OR optimize bundle size.
4. **Render rollback:** Render dashboard → service → **Deploys** tab → find the last green deploy → **Rollback to this deploy**. Takes ~30 sec. Use as the recovery step while you debug.

### Drainer not processing webhooks

1. Render → `winback-ai-drainer` → **Logs**. Should see periodic `Drainer tick` entries every few seconds.
2. If no ticks → drainer crashed at boot or is stalled.
   - Look for boot errors (ConfigError, Redis connection failed).
   - Restart the service from the dashboard.
3. If ticks are firing but webhooks aren't processed → check Neon for outbox events:
   ```sql
   SELECT id, type, "createdAt", "processedAt", "deadLetteredAt", attempts, "lastError"
   FROM "OutboxEvent"
   WHERE "merchantId" = '<the merchant>'
   ORDER BY "createdAt" DESC
   LIMIT 20;
   ```
4. Rows with `processedAt = NULL AND deadLetteredAt = NULL` are unprocessed. If they persist for >1 minute, the drainer is stuck (likely Redis lock issue or DLQ logic).
5. **Force-replay a dead-lettered row** via CLI:
   ```powershell
   $env:DATABASE_URL = "<neon pooled string>"
   $env:REDIS_URL = "<upstash string>"
   pnpm cli:outbox:replay <eventId> --reason "<text>"
   ```

### OAuth install loops or fails

1. Render → `winback-ai-web` → **Logs** during the install attempt. Look for the auth flow:
   ```
   GET /auth?shop=xxx
   ... 302 to Shopify
   GET /auth/callback?code=xxx&...
   ```
2. **Failure: `reason: missing_cookie`** → the state cookie was dropped. Verify `apps/web/app/services/auth-state.server.ts` still has `SameSite=None`. Browser-side: confirm the user isn't in strict-tracking-prevention mode (Brave, Firefox strict, Safari ITP can still block 3rd-party cookies).
3. **Failure: `application_cannot_be_found`** → `SHOPIFY_API_KEY` in Render doesn't match the Partners app's Client ID. Re-verify against `dev.shopify.com → Settings → Client credentials`.
4. **Failure: `admin.shopify.com refused to connect`** → embedded-app iframe blocked. Frame-ancestors CSP header is wrong OR Partners app config still points at the wrong App URL. Verify both match the Render URL exactly.
5. **Failure: redirect loop with no `missing_cookie`** → likely the post-OAuth landing route is crashing (the `_index` route bug we hit during initial Render bring-up). Check Render logs for stack traces; the OAuth callback wrote the Session row but the redirect target is 500-ing.

### Neon migration failed partway

See §1's failure-mode table above. Most common: P3009 / P3018 / connection error. Recovery is to either re-run `migrate deploy` OR use `prisma migrate resolve --applied/--rolled-back <name>` to mark the row correctly + then proceed.

### Cost spike — DeepSeek API bill higher than expected

1. Check Neon for the day's spend:
   ```sql
   SELECT date, SUM("spentMicrocents") / 100_000_000.0 AS spent_usd, SUM("generationCount") AS calls
   FROM "AiSpendBucket"
   WHERE date >= CURRENT_DATE - INTERVAL '7 days'
   GROUP BY date
   ORDER BY date DESC;
   ```
2. If aggregate is high → some merchant is generating heavily. Drill down:
   ```sql
   SELECT "merchantId", date, "spentMicrocents", "generationCount"
   FROM "AiSpendBucket"
   WHERE date >= CURRENT_DATE - INTERVAL '7 days'
   ORDER BY "spentMicrocents" DESC
   LIMIT 20;
   ```
3. **Containment:** raise `MerchantSettings.monthlyAiSpendCapCents` ceiling lower for the spending merchant, OR set it to 0 to pause generation entirely:
   ```sql
   UPDATE "MerchantSettings" SET "monthlyAiSpendCapCents" = 0 WHERE "merchantId" = '<the merchant>';
   ```
   (Pre-call ceiling check rejects all new generations immediately.)

---

## §4 — First-paying-merchant install checklist

Before announcing the app is open to a real paying merchant, walk through this checklist end-to-end on the dev store first.

- [ ] **8-scope union live on Partners dashboard.** `dev.shopify.com` → Winback AI → Configuration → 8 scopes listed under "Access scopes." Active version is the one with the 8-scope union (not the legacy 3-scope `0.2`).
- [ ] **Render production deploy live.** All 3 services show **Live** in Render dashboard. Each service's recent Logs show clean boot (no ConfigError, no crashloop).
- [ ] **Neon connection working.** `pnpm --filter @winback/db exec prisma migrate status` against the Neon DATABASE_URL shows "Database schema is up to date!"
- [ ] **Upstash Redis reachable.** Drainer logs show `BullMQ worker started` within 30 sec of boot.
- [ ] **DeepSeek API key valid.** From local: `curl -H "Authorization: Bearer <key>" https://api.deepseek.com/v1/models` returns the model list (HTTP 200).
- [ ] **OAuth round-trip works on dev store.** Install via Partners → consent → land in embedded admin. No redirect loop. Verify post-install via Neon: Session + Merchant + MerchantSettings + BillingSubscription rows exist.
- [ ] **Webhook delivery works.** Create a customer in the dev store admin → check drainer logs within 10 sec for the customer.create webhook processing.
- [ ] **ENCRYPTION_KEY backup recorded.** The 32-byte base64 key is in your password manager (1Password / Bitwarden / wherever). Lose this and every merchant session becomes unrecoverable.
- [ ] **CI gate green on main.** `git log main` shows the last commit passed CI; branch protection is active.
- [ ] **POINTS-TO-CONSIDER reviewed.** No open MUST-FIX items; the M10 list is pre-launch operator-acceptable.

If all 10 boxes tick, you can install on a paying merchant's store. If any one doesn't tick, resolve it before announcing.

---

## §5 — When to update this doc

Update OPERATIONS.md in the same commit as any change that affects:

- A production deploy command (build, start, env var)
- A migration deploy procedure
- A recovery playbook step (because something broke and we learned)
- The pre-merchant checklist

Out-of-scope for this doc:

- Architectural decisions (→ ARCHITECTURE.md)
- Design contracts (→ EPIC-X-DESIGN.md, CP2-ATTRIBUTION-CONTRACT.md, PRICING-MODEL-v1.md)
- Open hardening items (→ POINTS-TO-CONSIDER.md)
- Live state pointer (→ handoff.md)

If a change spans operations + architecture + design + tracker, prefer to update each doc in the same commit so a single SHA covers the full thought.

---

*This doc is the source of truth for "how to run the app." Every operator action should be either documented here or doc-able. The day after an incident is the right time to add the playbook step.*
