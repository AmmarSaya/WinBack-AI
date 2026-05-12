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
  },
});
