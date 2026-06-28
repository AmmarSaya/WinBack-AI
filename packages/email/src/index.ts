/**
 * Public exports for `@winback/email` (Epic G batch 8.4).
 *
 * Locked decisions:
 *   - L10: SDK error classes (`SESv2ServiceException` subclasses) are NOT
 *          re-exported. Callers see only the typed `EmailProviderError`
 *          subclasses. Re-exporting SDK types would couple caller code to
 *          the specific SDK version pinned in root `pnpm.overrides`.
 *   - 8.4: provider abstraction + Amazon SES (sandbox build) + env config
 *          are the three surfaces this package ships. The dispatch worker
 *          (`apps/drainer/src/workers/dispatch.worker.ts`) is the only
 *          consumer at 8.4; the smoke CLI (`apps/cli/src/dispatch/smoke.ts`)
 *          imports the provider factory directly for manual sandbox
 *          verification.
 */

// Provider abstraction + 6 typed errors.
export {
  type EmailProvider,
  type EmailProviderErrorCode,
  type EmailProviderName,
  type EmailSendAccepted,
  type EmailSendArgs,
  EmailProviderAccountSuspendedError,
  EmailProviderAuthError,
  EmailProviderError,
  EmailProviderInvalidRequestError,
  EmailProviderRateLimitError,
  EmailProviderRecipientSuppressedError,
  EmailProviderTransientError,
} from './providers/interface.js';

// Concrete provider + factory.
export {
  AmazonSesProvider,
  buildSendEmailInput,
  createAmazonSesProvider,
  mapSesError,
} from './providers/amazon-ses.js';

// Active-provider selector. Lazy + memoised.
export {
  _resetEmailProviderCacheForTests,
  selectActiveEmailProvider,
} from './providers/index.js';

// Env config. Throws ConfigError synchronously at boot on misconfiguration.
export {
  type EmailConfig,
  type GetEmailConfigOptions,
  getEmailConfig,
} from './config.js';
