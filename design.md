# UI Design — AI Customer Winback

Companion to `ARCHITECTURE.md`. Captures the current UI decisions so they're
greppable when D2-Epic-G backend work resumes. Decisions here evolve as the
UI evolves — revise this file as the design changes, no formal ceremony.

Scope: a real-looking embedded Shopify app shell with honest empty states.
No fake data. Real merchant-facing UI lands at Epic G+/H1 when there's
actually data to display.

---

## Core principles

1. **No fake data.** Empty cards say "Available when Epic E ships" (or G,
   or H1 — name the unlocking epic). Never `$0` standing in for "we have
   no data" — that trains muscle memory that the dashboard is wired up.

2. **Loader tests need a real-Prisma harness — currently deferred.**
   The ALS-callback bug only manifests against real Prisma (mocked
   Prisma resolves sync, ALS propagates fine, mock tests pass while the
   real bug ships). Adding a `@winback/web` integration harness mirroring
   `@winback/db`'s `pnpm db:test` is its own task — see deferred register.
   Until then, the install / loader paths are manually verified via
   dev-store install on every UI change. Static placeholder pages don't
   need tests at all.

3. **Polaris 13 actual APIs only.** See the table below for what's valid
   vs. invalid in the installed version.

4. **App Bridge nav, not Polaris Navigation.** `<ui-nav-menu>` puts the
   nav in Shopify admin's own sidebar (where Products / Orders live), so
   the app gets the full content width and looks like a native Shopify
   app. Polaris `<Navigation>` would render inside the iframe and eat
   content width — the older, less-integrated pattern.

5. **URL state, not React state**, for anything a merchant might bookmark
   or share — tab selections, filters, etc. live in search params.

---

## Scope

### IN — what we build now

- `root.tsx` — add Polaris `<Frame>` around `<Outlet>`. Add App Bridge
  `<ui-nav-menu>` with the four routes.
- `_index.tsx` — keep the existing loader (proves install). Replace body
  with a 2×2 grid of honest empty-state cards.
- `/customers` — static placeholder page with `EmptyState`.
- `/campaigns` — static placeholder page with `EmptyState`.
- `/settings` — loader reads `MerchantSettings` row (created at install),
  body shows the values read-only.
- Loader tests for `/` and `/settings`.

### OUT — explicit non-goals for this step

- Charts, graphs, time series
- Any write actions (form submissions, mutations)
- Per-customer drill-down views
- Real-time updates / polling
- Toasts / modals / notifications (they're free once `<Frame>` is wired,
  but there's nothing to notify about yet)
- Mobile-specific layout

### DEFERRED — tied to specific future epics

| Surface | Epic that unblocks | Why |
|---|---|---|
| Revenue Recovered (real number) | H1 | Needs `MetricsDailyRollup` |
| Customers Won Back (real number) | H1 | Needs `AttributionEvent` aggregates |
| Customer list + churn scores | Epic E | Needs `CustomerScore` + `Segment` |
| Customer state visualization | Epic E | `state` is always `active` today |
| Campaign list / create flow | Epic G | Needs `Campaign`, `Workflow`, `Message` |
| AI generation cost dashboard | Epic F | Needs `AiSpendBucket` |
| Settings edit form | M10 | Operator-facing fields land at M10 |

---

## Navigation

App Bridge `<ui-nav-menu>` in `root.tsx`, four entries:

```
Home          → /            (rel="home")
Customers     → /customers   (Epic E placeholder)
Campaigns     → /campaigns   (Epic G placeholder)
Settings      → /settings    (M10 placeholder, reads MerchantSettings now)
```

Each link is a plain `<a href="...">` inside the `<ui-nav-menu>` web
component — App Bridge intercepts and turns it into embedded-admin
navigation.

---

## Page specs

### `/` — Home

**Loader:** unchanged. Reads `shop` query param, looks up Merchant in
`withSystemScope`, redirects to `/auth` if not installed. The
async-callback pattern fix from the OAuth debugging stays.

**Body:** Polaris `Page` titled "AI Customer Winback" + a 2×2 grid via
`Layout` + `Layout.Section variant="oneHalf"`. Four cards, each with a
heading and an `EmptyState`-style body referencing its unlocking epic:

| Card | Body copy | Unlocks |
|---|---|---|
| Revenue Recovered | "Available when Epic H1 (attribution + rollup) ships." | H1 |
| Customers Won Back | "Available when Epic H1 ships." | H1 |
| Active Campaigns | "Available when Epic G (campaigns + messaging) ships." | Epic G |
| At-Risk Customers | "Available when Epic E (RFM + churn scoring) ships." | Epic E |

When real backend ships, swap the body of each card without changing the
grid structure.

### `/customers` — Placeholder

Static. Polaris `Page` + `EmptyState` ("Customer intelligence arrives at
Epic E"). No loader.

### `/campaigns` — Placeholder

Static. Polaris `Page` + `EmptyState` ("Campaigns arrive at Epic G"). No
loader.

### `/settings` — Read-only

**Loader:** in `withTenantScope`, read `MerchantSettings` for the merchant.
Return `attributionDirectWindowDays`, `attributionAssistedWindowDays`,
`sendTimeStartHour`, `sendTimeEndHour`, `monthlyAiSpendCapCents`,
`monthlySendsCap`.

**Body:** Polaris `Page` + read-only `BlockStack` listing each setting and
its value. Footer caption: "Edit support lands at M10."

---

## Polaris 13.x API — what's valid

Pre-empts common drift. Code review rejects anything from the right column.

| Use | Don't use |
|---|---|
| `Layout.Section variant="oneHalf"` | `Layout.TwoColumns` (doesn't exist) |
| `Layout.Section variant="oneThird"` | `Layout.ThreeColumns` (doesn't exist) |
| `BlockStack gap="400"` (SpaceScale token) | `BlockStack gap="5"` |
| `BlockStack` | `Stack` (deprecated v12+) |
| `InlineStack gap="200"` | `Inline` (renamed) |
| `EmptyState` for "no data yet" | hand-rolled "Coming soon" divs |
| `Text as="h2" variant="headingMd"` | bare `<h2>` |

---

## Revisit

This shell carries through Epic E + G unchanged. At Epic G close, swap the
empty card bodies for real-data queries — the grid, nav, Frame, routes,
and loader tests all stay.
