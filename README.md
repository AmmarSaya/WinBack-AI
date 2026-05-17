# WinBack AI

**Building toward an AI-powered customer winback platform for Shopify merchants.**

> **Pre-MVP. Foundation work in progress. No merchant-facing features ship yet.**
> Today this repo contains the multi-tenant platform plumbing (database, outbox, queues, OAuth, webhook ingest, encrypted sessions) plus the operational substrate around it (outbox drainer with DLQ, cron scheduler, operator CLI). The product features described in the vision below — churn prediction, AI-generated campaigns, cross-channel delivery, revenue attribution — are scoped and queued, not built. See [Current status](#current-status) for what actually exists.

---

## The problem (eventually)

Repeat customers drive the majority of revenue for established Shopify stores, yet most merchants let a large share of their first-time buyers go dormant within 90 days. The "winback" tools they pay for tend to be templated email blasts on a fixed schedule — they ignore why a customer stopped buying, when they're actually reachable, and whether the campaign caused the next order or merely coincided with it.

The result: merchants pay for re-engagement they can't measure, and customers get generic discount nags that train them to wait for the next coupon.

## The vision (not yet built)

A multi-tenant embedded Shopify app that will:

1. **Detect dormancy and predict churn risk per customer**, using RFM segmentation and signals from order history, browse activity, and prior campaign response.
2. **Generate AI-personalized campaigns** across email, SMS, and WhatsApp — with content, channel, and timing matched to each segment.
3. **Attribute recovered revenue** to specific campaigns with a documented, configurable model (see [CP2-ATTRIBUTION-CONTRACT.md](CP2-ATTRIBUTION-CONTRACT.md)) — so the dashboard number is one a CFO can defend.

Target eventual scale: 10,000+ merchants on shared infrastructure. None of that is live. None of it serves a merchant today.

## Current status

Honest snapshot. Live state lives in [handoff.md](handoff.md).

### What exists today

- **Monorepo + tooling.** pnpm workspaces, TS 5.7 strict with composite project references, Vitest, Prisma 5, Docker-based integration test harness.
- **Multi-tenant database (`@winback/db`).** Prisma schema with `merchantId` on every business table, composite uniques, soft-delete on customer-facing tables, repositories extending `BaseRepository`, single composing Prisma Client Extension that enforces tenant scope at the query layer.
- **Tenant scope discipline (`@winback/db` + `@winback/contracts`).** `AsyncLocalStorage`-backed `withTenantScope` and `withSystemScope` — the latter requires a registered `SYSTEM_SCOPE_REASONS.*` constant.
- **Outbox primitives (`@winback/db` + `@winback/contracts`).** `OutboxEvent` table, `OutboxRepository.claimBatch` with `FOR UPDATE SKIP LOCKED` concurrency, integration-tested.
- **Queue primitives (`@winback/queue`).** BullMQ 5 + ioredis 5, shared-client rule for Queues, dedicated-client rule for Workers, deterministic shutdown via `disconnect` + `'end'` event.
- **Encrypted session storage (`@winback/crypto`).** AES-256-GCM decorator over `@shopify/shopify-app-session-storage-prisma`, format `v1:<base64(iv||tag||ciphertext)>`.
- **Config (`@winback/config`).** Strict Zod-validated env loading. `getRedisConfig` refuses `REDIS_TLS_REJECT_UNAUTHORIZED=false` in production.
- **Typed errors (`@winback/errors`).** `toHttp` envelope, `isRetryable` classification.
- **Shopify SDK wrapper (`@winback/shopify`).** `AdminClient.graphql(merchantId, args)` — no `accessToken` ever passed by callers. `CostTracker` for the leaky bucket.
- **`apps/web`.** Install + OAuth callback (with `subscribeAllWebhooks`), webhook ingest with HMAC verification and fast-ack (HMAC → atomic tx [idempotency + log + outbox] → 200), embedded admin UI shell (Polaris 13, App Bridge nav, honest empty states), health endpoints.
- **`apps/drainer`.** BullMQ Worker on `outbox.drain`. Self-re-enqueueing ticks, GDPR / merchant / order dispatch, MARK_BEFORE_INVOKE policy for the two-phase events, retry-with-ceiling and DLQ.
- **`apps/scheduler`.** BullMQ Workers on `cron.rollup` (hourly UTC, body stubbed for H1) and `cron.sweep` (15-min enrichment retry).
- **`apps/cli`.** Operator commands — `pnpm cli:outbox:replay <id> --reason "..."` and `pnpm cli:outbox:dead-letter <id> --reason "..."`. Writes `AuditLog` rows in the same tx as the state transition.

That is the *only* thing that exists. None of this touches a merchant's customers, generates a message, or measures a recovered dollar.

### Roadmap

| Checkpoint | Status |
|---|---|
| CP-1: Foundations | Done |
| CP-2: Attribution contract | Approved 2026-05-13 (contract only — no implementation) |
| D1: Queue primitives + Redis config + outbox `claimBatch` tests | Done |
| D2: Outbox drainer + Worker wiring + `subscribeAllWebhooks` | Done |
| D3: Cron scheduler (rollup, enrichment retry) | Done |
| D4: DLQ + retry ceiling + operator CLI | Done |
| D5: Redis-backed idempotency store | Deferred indefinitely — no business case at current scale |
| **`apps/web` integration harness vs Epic E** | **Next — conscious decision (senior review recommends harness first)** |
| CP-3: Load test (1k webhooks/sec × 10 min) | Queued |
| Epic E: Intelligence — RFM, churn scoring, state machine | Queued (no code yet) |
| Epic F: AI orchestration | Queued (no code yet) |
| Epic G: Campaigns + messaging (email / SMS / WhatsApp models + delivery) | Queued (no code yet) |
| H1: Attribution implementation + analytics | Queued (no code yet — only the contract is approved) |
| M10: Hardening, billing, security review | Pre-launch |

### Test counts (verified at the most recent commit)

| Suite | Count |
|---|---|
| Unit (all packages + apps) | 428 |
| Integration — Postgres (`pnpm db:test`) | 13 |
| Integration — Redis (`pnpm queue:test`) | 4 |

## Architecture

Cross-cutting policies are **locked** and live in [ARCHITECTURE.md](ARCHITECTURE.md). A non-exhaustive sample of what is *not* up for casual revision:

- Multi-tenancy via `merchantId` on every business table, enforced at the Prisma query layer
- Money as `BigInt` cents + ISO 4217 currency — never `Float`/`Decimal`
- UTC everywhere; merchant-local windows resolved at query time via `Merchant.timezone`
- Outbox pattern for cross-aggregate side effects; `AuditLog` writes go *direct*, never through the outbox
- `AsyncLocalStorage` tenant scope; `withSystemScope(reason, fn)` is the only escape hatch and every reason is a registered constant
- Soft-delete on customer-facing tables; the extension auto-filters
- Offline-token model only; `@shopify/shopify-app-remix`'s `authenticate.admin` / `authenticate.webhook` are **not** used

If a change crosses one of those lines, it gets a written counter-proposal in `ARCHITECTURE.md` — not a quiet PR.

### Monorepo layout

```
apps/
  web/                  Remix app — OAuth, embedded admin UI, webhook ingest
  drainer/              BullMQ Worker — outbox drain, dispatch, DLQ
  scheduler/            BullMQ Workers — hourly rollup, 15-min enrichment sweep
  cli/                  Operator commands — outbox replay / force-DLQ
packages/
  contracts/            Shared registries: events, audit actions, scopes, queues
  errors/               Typed error envelope (toHttp), retry classification
  crypto/               AES-256-GCM field encryption
  config/               Zod-validated env config (core, redis)
  db/                   Prisma schema, repositories, Prisma Client Extension
  shopify/              AdminClient, cost tracker, webhook verification
  queue/                BullMQ + ioredis primitives
  logger/               Structured logging
```

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node 20.11 |
| Package manager | pnpm 9.15 |
| Language | TypeScript 5.7 (strict, composite) |
| Web framework | Remix 2.15 |
| UI | Polaris 13 + React 18 |
| ORM | Prisma 5.22 |
| Validation | Zod 3.25 |
| Queue | BullMQ 5.76 + ioredis 5.10 |
| Shopify SDK | `@shopify/shopify-api` 11.14 |
| Shopify Admin API | 2026-04 |
| Tests | Vitest 2.1.9 |

Versions are pinned in `pnpm.overrides` and individual `package.json` files. Do not bump opportunistically — see [handoff.md](handoff.md).

## Getting started

### Prerequisites

- Node 20.11+
- pnpm 9.15+
- Docker Desktop (required for the integration test harness and for dev Postgres / Redis)
- A stable HTTPS tunnel (ngrok with a reserved static domain, or equivalent)

> **You cannot run this on `http://localhost`.** Shopify embedded apps load in an iframe and OAuth requires a stable HTTPS URL. Read [apps/web/README.md](apps/web/README.md) before running the dev server — it explains the tunnel setup and the failure modes if you skip it.

### One-time setup

```bash
pnpm install
pnpm build
pnpm -r test                      # 428 unit tests
pnpm db:test                      # Postgres integration tests (Docker)
pnpm queue:test                   # Redis integration tests (Docker)
```

### Local development

Two-terminal flow for the embedded app:

```bash
# Terminal 1 — stable HTTPS tunnel to localhost:5173
ngrok http --domain=<your-domain>.ngrok-free.dev 5173

# Terminal 2 — dev DB + Redis + web dev server
pnpm db:dev:up                                          # dev Postgres on :5432/winback (docker-compose.dev.yml)
docker compose -f docker-compose.test.yml up -d redis   # dev Redis on :6380 — intentionally shared with the test compose; see header of docker-compose.dev.yml for why
pnpm --filter @winback/web dev                          # web on :5173
```

Background processes (run as needed in additional terminals):

```bash
pnpm drainer:dev      # outbox drainer
pnpm scheduler:dev    # cron scheduler (rollup + enrichment sweep)
```

Tear down dev Postgres with `pnpm db:dev:down` when finished. Dev Redis lives in the test compose file and is shared with `pnpm queue:test`.

## Testing

| Command | What it runs |
|---|---|
| `pnpm -r test` | All unit suites across the workspace |
| `pnpm --filter @winback/<pkg> test` | One package |
| `pnpm db:test` | Postgres integration suite (boots `docker-compose.test.yml`) |
| `pnpm queue:test` | Redis integration suite (boots `docker-compose.test.yml`) |
| `pnpm build` | Real compile — the source of truth for "does it typecheck" |

`pnpm typecheck` is only reliable with a warm `tsbuildinfo` cache (a known limitation of `tsc -b --noEmit` with composite project references — queued for the M10 tooling pass). Use `pnpm build` when in doubt.

## Default branch

`main`. PRs target `main`. (The original `master` branch was renamed during housekeeping.)

## Contributing

This is a private project, not currently accepting external contributions. If you are a collaborator:

1. Read [ARCHITECTURE.md](ARCHITECTURE.md) and the relevant subsystem file header before touching code.
2. New auditable action, system-scope reason, or queue name? Register the constant in `@winback/contracts` first, then use it at the call site. The registries are exhaustively tested in `packages/contracts/tests/registries.test.ts`.
3. Multi-step domain writes go through a repository; single-step transactional writes inside `UnitOfWork.run` may use `tx.<model>` directly. Full rule in `ARCHITECTURE.md` under "Repository Chokepoint Policy."
4. Integration tests over mocks where infrastructure behavior is load-bearing.

## License

Proprietary. All rights reserved. © 2026 Ammar Saya.
