# Shopify Scopes Audit — AI Customer Winback

**Status:** APPROVED — 2026-05-21.  Every locked decision below was reviewed + signed off in the audit pass that produced this document.  No production `SHOPIFY_SCOPES` change ships without referencing this file.
**Scope:** Every Shopify Admin API scope this app will need across Epics A–H.  Locked here BEFORE the first paying merchant installs.
**Why this doc exists:** Shopify policy — adding a new OAuth scope AFTER install forces every existing merchant to accept a re-authorization prompt.  Merchants who ignore the prompt see the app silently degrade.  Shipping the full scope union at first install avoids that entire failure mode.

---

## Currently in production

> **Status reference at audit approval (2026-05-21):** the three-scope baseline below was what the codebase + Partners portal carried when this audit was approved. **All pre-launch sync tasks completed 2026-05-22:** `.env.example` template and `.github/workflows/ci.yml` env block carry the 8-scope union; Partners dev dashboard synced at app-config version `0.3`; production deploy live on Render with the 8-scope union set on the web + drainer + scheduler services. First paying-merchant install is unblocked. See Migration strategy section for the per-task closure detail.
>
> **For current live status (post-this-doc-approval), see the Migration strategy section's ✅/⚠️ checklist — that is the authoritative source.**

Audit-time baseline — three scopes, sourced from `SHOPIFY_SCOPES` in:

- `apps/web/.env` (dev template — handoff `New Session Bootstrap Prompt`)
- `.github/workflows/ci.yml:46` (CI run-time)
- the deployed app's Partners-portal config (manual sync per Shopify console)

```
read_customers, read_orders, write_discounts
```

| Scope | Currently used at |
|---|---|
| `read_customers` | Customer webhook ingest (Epic E) + customer-FK resolution in Order upsert (P-10) |
| `read_orders` | Order webhook ingest (Epic E) + qualifying-transition computation (CP-2 §Q1) + line-item FK resolution |
| `write_discounts` | Reserved for Epic G — winback messages may include merchant-approved discount codes |

`write_discounts` is shipped early because it costs nothing today and avoids a future re-auth.

---

## Per-epic additions (locked decisions)

### Epic E — Customer Scoring + State Machine

**No new scopes.**  RFM scoring + state machine operates entirely on data already ingested via `read_customers` + `read_orders`.

### Epic F — AI Generation

The LLM call site needs richer context than just customer + order data for the prompt to produce useful copy.

| Scope | Why it's needed for F | Risk if NOT added |
|---|---|---|
| `read_products` | Product context for "you might like X" / replenishment prompts.  Product title, vendor, type fed into the prompt so the AI doesn't hallucinate product names. | Generated messages reference products by SKU only or invent product names — both unacceptable. |
| `read_inventory` | "Back in stock" trigger detection + "low stock urgency" copy ("Only 3 left — last we saw, you were looking at this").  Needs `ProductVariant.inventoryQuantity` populated from `read_inventory`. | F lands without inventory-aware copy — works but a clear capability gap. |
| `read_price_rules` | Surface existing merchant discount codes in winback message body ("Your VIP code 'WINBACK10' is still valid"). | F can still call `write_discounts` to MINT a new code per message, but cannot reference existing merchant-curated rules.  Worse merchant UX (clutters their discount-code list). |

### Epic G — Campaigns + Messaging

| Scope | Why it's needed for G | Risk if NOT added |
|---|---|---|
| `write_marketing_events` | Marketing Activities API.  Publishes send events visible in the merchant's Shopify admin dashboard.  **Locked send channel** — merchants need send events visible in the place they already live; an off-platform ESP means running a campaign tool with zero Shopify-admin visibility. | Merchant has no in-admin record that campaigns ran.  Severe UX gap — they'd see revenue impact but not the cause. |
| `read_marketing_events` | Read back our own published Marketing Activities for dedup (avoid double-publishing on replay) + per-campaign reporting cross-checks. | Workable without it — internal `Campaign` + `Message` tables are the source of truth — but operator forensic capability degrades. |

**Customer tagging post-send (`write_customers`) — OUT of scope for G.**  Send-state tracking lives in `CampaignTarget` + `MessageEvent` tables.  Writing to `Customer.tags` creates collision risk with merchant-curated tags and is hard to clean up.  If a merchant explicitly requests tag-based segmentation in a later epic, revisit then.

### Epic H — Attribution

**No new scopes.**  AttributionEvent ingest works off `read_orders` webhook deliveries (refund transitions, paid transitions — both `orders/updated` topic).  Per-currency rollup math operates on already-ingested Order + Message data.

### Mandatory GDPR webhook subscriptions

NOT scope-gated.  Shopify always delivers these regardless of installed scopes:

- `customers/data_request`
- `customers/redact`
- `shop/redact`

Listed here for completeness only.  Already handled by the C6 GDPR processor.

---

## Final consolidated scope list at first-merchant install

Eight scopes total:

```
read_customers,
read_orders,
read_products,
read_inventory,
read_price_rules,
write_discounts,
write_marketing_events,
read_marketing_events
```

Encoded as the `SHOPIFY_SCOPES` env var:

```
read_customers,read_orders,read_products,read_inventory,read_price_rules,write_discounts,write_marketing_events,read_marketing_events
```

Five new scopes added to the current three.  All five are merchant-comfortable (no PII beyond what `read_customers` already exposes; nothing in the "sensitive / approval-required" Shopify tier).

---

## Deferred scopes — known + intentionally out

These are NOT in the install union.  Each has a real-but-narrow use case that doesn't justify the OAuth-prompt friction at first install.

| Scope | What it would unlock | When to add |
|---|---|---|
| `read_locations` | Multi-location inventory signals — "back in stock at your nearest store" copy in Epic F messages.  Single-location merchants don't need it; we don't ship location-aware triggers in F v1. | If/when we add location-aware prompts.  Re-auth risk acceptable because it's an opt-in upgrade per merchant. |
| `read_locales` | Multi-language store support — translate generated copy into the merchant's storefront locale(s).  Out of scope until i18n is a stated goal. | If/when i18n ships as a planned feature.  Likely a future epic, not an in-cycle decision. |

Two scopes considered + rejected:

- `read_shopify_payments_disputes` — no plausible use case in the winback arc; chargebacks aren't a signal we act on.
- `write_customers` — collision risk with merchant tags; tracked internally in our schema instead (per G locked decision above).

---

## Migration strategy

**Pre-launch (now):** add F + G scopes to `SHOPIFY_SCOPES` before the first paying merchant installs.

This is the only path that avoids the re-auth gauntlet.  Concrete tasks:

1. ✅ **DONE 2026-05-22** — Production deploy provisioned on **Render** (Singapore region). Three services live: `winback-ai-web` (Starter), `winback-ai-drainer` (Background Worker), `winback-ai-scheduler` (Background Worker). `SHOPIFY_SCOPES` env var set to the 8-scope union string on all three services. External Neon Postgres (`neondb` database, `winback-ai` project, AWS Asia Pacific 1 Singapore) and Upstash Redis (Singapore region) wired. Install verified end-to-end on dev store: OAuth handshake completes, Session + Merchant + MerchantSettings + BillingSubscription rows persisted to Neon, install OutboxEvent rows enqueued for drainer.
2. ✅ **DONE 2026-05-22** — Partners dev dashboard (`dev.shopify.com`) synced to the 8-scope union. New app-config version `0.3` released and active. Operator verified the 8 scopes are listed on the post-release config view. Previous live version `0.2` (3-scope baseline) superseded; the Versions card shows `0.3 Active`. No existing paying merchants at sync time, so the re-authorization-prompt risk per §Re-authorization risk did not bite.
3. ✅ `.env.example` template updated. `handoff.md` is gitignored; user maintains locally.
4. ✅ `.github/workflows/ci.yml` env block updated.
5. ✅ No CLAUDE.md tracked references to the scope set; nothing to update.

**Both pre-launch operator tasks completed 2026-05-22.** The 8-scope union is now consistently declared across all surfaces (codebase env templates + CI + Partners dashboard + Render production deploy env). First paying-merchant install is unblocked from a scopes-and-deploy perspective.

**Hosting decision recorded:** Render was chosen over Fly.io after Fly's Stripe payment-verification rules blocked all available cards (Privacy.com / virtual / Wise variants all rejected). Render's payment acceptance is wider and the same three-service architecture (one Web Service + two Background Workers) maps cleanly. Cost floor: ~$21/mo (3× Starter). External Neon + Upstash on free tiers add $0/mo. See operator's runbook for re-provisioning steps if Render setup needs to be reproduced.

**Production-deploy hotfixes shipped alongside the deploy** (caught on first install attempt against Render):
- `apps/web/app/routes/_index.tsx` — switched `return new Response(400)` to `throw new Response(400)` for the missing-shop guard so Remix doesn't render the default component with undefined loader data (Render's `HEAD /` health probe surfaced the bug). Defensive `?? 0` added to the state-band counts render as belt-and-suspenders.
- `apps/web/app/services/auth-state.server.ts` — OAuth CSRF state cookie changed from `SameSite=Lax` to `SameSite=None`. Required because Shopify embedded apps render inside an `admin.shopify.com` iframe; the OAuth round-trip through `accounts.shopify.com` is a cross-site sub-request within that iframe, and `Lax` cookies are dropped on those redirects. Without this fix every `/auth/callback` failed with `reason: missing_cookie` and the install looped forever.

Both fixes shipped on `fix/index-route-empty-state-crash` branch; merged to `main`.

**Post-launch staged (rejected):** ship narrow now, expand per-epic.  Each expansion forces every existing merchant to re-OAuth.  Terrible UX, real merchant attrition risk.

**Mid-cycle expansion (still rejected for F+G):** add scopes only after the consuming epic ships.  Same re-auth problem; just delays it.

---

## Re-authorization risk — operational note

Shopify's OAuth scope handling:

- When an app's scopes change AFTER install, Shopify shows a re-authorization prompt the next time the merchant opens the app's admin page.
- Merchants can dismiss the prompt indefinitely.  The app continues running with the OLD scope set — new scope-gated APIs return `403`.
- Some merchants ignore prompts for weeks or never re-authorize.
- The app has no programmatic way to force re-auth or detect ignored prompts.  Best signal is API `403` rates.

This is the operational gotcha this audit exists to prevent.  The audit's recommendation — install with the full F + G union from day one — avoids it entirely.

---

## Approval gate

This audit is approved when:

- [x] Send-channel decision (Shopify Marketing Activities API as primary) is locked
- [x] Customer-tagging decision (`write_customers` out of scope) is locked
- [x] Deferred-scope list (`read_locations`, `read_locales` documented as known-deferred) is locked
- [x] Final consolidated install scope list (8 scopes) is approved
- [x] Migration strategy (pre-launch full union) is approved

**All five gates cleared 2026-05-21 — this document is the locked source of truth.**  The migration-strategy tasks (Partners portal sync + env updates + CI env block update + handoff doc refresh) are separate pre-launch operational work; they reference this audit but are not gated by it.

---

## Cross-references

- `CP2-ATTRIBUTION-CONTRACT.md` — Q1 + Q2 reference `orders/updated` payloads that `read_orders` already covers; no new scope needed for H attribution beyond what's in production.
- `EPIC-E-FIELD-MAPPING.md` — All Order + Customer fields mapped from `read_orders` / `read_customers` deliveries; lists no field requiring a scope not in the current production set.
- `EPIC-E-SESSION-2-DESIGN.md` — Scoring math operates on already-ingested data; no scope dependency.

---

*This document is the source of truth for Shopify OAuth scopes across the AI Customer Winback app.  Any future scope addition or removal MUST update this file in the same change.*
