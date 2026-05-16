/**
 * AdminClient construction helper.
 *
 * Promoted from inline duplication after N=3 call sites:
 *
 *   - apps/web/app/routes/auth.callback.tsx step 8b (post-install
 *     webhook subscription)
 *   - apps/drainer/src/handlers/merchant.ts (merchant.installed
 *     handler — enrichInstall + customer backfill)
 *   - apps/scheduler/src/handlers/enrichment-sweep.ts (D3 cron sweep —
 *     retry failed enrichments)
 *
 * The `config` parameter is explicit so callers that already have
 * `ShopifyConfig` in scope (typically because they parsed it for a
 * different concern in the same request) don't trigger a second
 * `getShopifyConfig()` call. When omitted, this function fetches
 * config itself.
 *
 * Single source of truth for the four-line ritual. Future callers
 * import this rather than duplicating.
 */

import { Cipher, decodeKey } from '@winback/crypto';
import type { WinbackPrisma } from '@winback/db';

import { type ShopifyConfig, getShopifyConfig } from '../config.js';
import { AdminClient } from './client.js';
import { CostTracker } from './cost-tracker.js';
import { PrismaShopifyTokenResolver } from './token-resolver.js';

export function buildAdminClient(
  prisma: WinbackPrisma,
  config?: ShopifyConfig,
): AdminClient {
  const resolvedConfig = config ?? getShopifyConfig();
  const cipher = new Cipher(decodeKey(resolvedConfig.ENCRYPTION_KEY));
  const resolver = new PrismaShopifyTokenResolver(prisma, cipher);
  const tracker = new CostTracker();
  return new AdminClient(resolver, tracker);
}
