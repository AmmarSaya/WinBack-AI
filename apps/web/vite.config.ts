import { vitePlugin as remix } from '@remix-run/dev';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [
    remix({
      ignoredRouteFiles: ['**/*.test.{ts,tsx}'],
    }),
    tsconfigPaths(),
  ],
  server: {
    // Required for Shopify embedded app: bind to all interfaces so the
    // tunnel (ngrok / Cloudflare) can reach the dev server.
    host: '0.0.0.0',
    // Allow the dev server to accept requests whose Host header matches
    // any dev tunnel provider we use. Leading-dot subdomain match means
    // the static-domain part can change without touching this config.
    //   .ngrok-free.dev    — ngrok free static domains (current setup)
    //   .ngrok-free.app    — ngrok older free TLD (in case ngrok moves)
    //   .trycloudflare.com — Cloudflare quick tunnels (legacy fallback)
    allowedHosts: ['.ngrok-free.dev', '.ngrok-free.app', '.trycloudflare.com'],
  },
});
