import type { EmailConfig } from '../config.js';

import { createAmazonSesProvider } from './amazon-ses.js';
import type { EmailProvider } from './interface.js';

/**
 * Lazy provider construction (mirrors `packages/ai/src/providers/index.ts`
 * L6). Memoised by config-reference. A test that calls `getEmailConfig(
 * { reset: true })` + this selector twice gets two different providers
 * (different config objects). Production callers hand the same
 * `getEmailConfig()` result around for the lifetime of the process, so
 * reference equality matches the lifecycle.
 */

let cached: { readonly config: EmailConfig; readonly provider: EmailProvider } | null = null;

export function selectActiveEmailProvider(config: EmailConfig): EmailProvider {
  if (cached !== null && cached.config === config) {
    return cached.provider;
  }
  const provider = constructForProvider(config);
  cached = { config, provider };
  return provider;
}

function constructForProvider(config: EmailConfig): EmailProvider {
  // Single-branch construction at 8.4. The discriminated union shape is
  // future-proofing — when a second EmailProvider lands, this becomes a
  // switch with an exhaustive `never` default (mirrors `packages/ai`).
  return createAmazonSesProvider({
    region: config.AWS_REGION,
    accessKeyId: config.AWS_SES_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SES_SECRET_ACCESS_KEY,
  });
}

/** Reset the memoised provider. Tests use this between scenarios. */
export function _resetEmailProviderCacheForTests(): void {
  cached = null;
}
