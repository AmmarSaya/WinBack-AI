# @winback/web — Embedded App Shell

The Remix app that serves the embedded Shopify experience and handles OAuth.

## Required dev setup: HTTPS tunnel (non-negotiable)

The Shopify embedded app loads in an iframe inside Shopify admin. Browsers
require all iframe content over HTTPS. Additionally, Shopify's OAuth flow
sets session cookies tied to the app URL — sessions tied to a URL that
changes will break on the next install attempt.

**You cannot run `apps/web` on `http://localhost`.** It will not work for
OAuth, will not work for App Bridge, and will not work for embedded loading.

### Choose a tunnel and stick with it

Two acceptable options. Pick one, document the URL, and don't change it
between sessions (sessions are tied to it).

**Option A — ngrok (free with a fixed subdomain on a paid account)**

```bash
ngrok http 3000 --domain=<your-fixed-subdomain>.ngrok-free.app
```

**Option B — Cloudflare Tunnel (free, requires Cloudflare account)**

```bash
cloudflared tunnel run <named-tunnel>
```

Whichever you pick, the tunnel's HTTPS URL is **the** `SHOPIFY_APP_URL`.
Set it in `.env` once and don't change it casually:

```dotenv
SHOPIFY_APP_URL=https://your-stable-tunnel.ngrok-free.app
```

If the tunnel URL changes:
1. Every existing dev install in the test store breaks (sessions invalid).
2. You must reinstall the app from `/auth?shop=...` to issue a new session
   tied to the new URL.

### Why this is in the README, not optional notes

Operators who run `npm run dev` without reading this will:
1. Use `localhost`, watch OAuth fail, blame the OAuth code.
2. Use an ephemeral tunnel URL that changes daily, then debug why their
   test merchant's session "randomly stops working."

Both have happened on every Shopify app I've ever shipped. This file
exists to prevent both.

## Local install flow (smoke test)

1. Tunnel running, `SHOPIFY_APP_URL` set.
2. `pnpm --filter @winback/web dev`.
3. In the Shopify Partner dashboard, set the app's URLs to match the
   tunnel + `/auth/callback`.
4. Navigate to `https://<tunnel>/auth?shop=<test-shop>.myshopify.com`.
5. Approve scopes in Shopify admin.
6. Expect: redirect back to `/` with merchant + session both committed.
7. Verify: `psql ... -c 'SELECT shop FROM "Merchant"'` returns the shop.

## Health endpoints

| Endpoint    | Purpose                                              |
| ----------- | ---------------------------------------------------- |
| `/healthz`  | Liveness — always 200 if the process is responding.  |
| `/readyz`   | Readiness — 200 only if Postgres reachable.          |
