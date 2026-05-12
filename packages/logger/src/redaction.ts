/**
 * Default pino `redact.paths` applied to every log record emitted by the
 * workspace's root logger.
 *
 * Pino redact is path-based and resolved at construction time. We list the
 * common secret-shaped field names encountered across HTTP, webhooks, queue
 * payloads, and domain events. Subsystems may concatenate their own paths
 * when needed, but should not remove from this list.
 *
 * This is defense-in-depth. The primary defense remains never putting secrets
 * into log records — treat this catalog as a safety net, not a license.
 */
export const DEFAULT_REDACT_PATHS: readonly string[] = Object.freeze([
  // Generic secret-shaped field names at any depth
  '*.password',
  '*.passcode',
  '*.passphrase',
  '*.token',
  '*.access_token',
  '*.accessToken',
  '*.refresh_token',
  '*.refreshToken',
  '*.secret',
  '*.api_secret',
  '*.apiSecret',
  '*.api_key',
  '*.apiKey',
  '*.client_secret',
  '*.clientSecret',
  '*.credential',
  '*.credentials',
  '*.authorization',
  '*.privateKey',
  '*.private_key',

  // HTTP request shape (set when handlers log raw req objects)
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-shopify-hmac-sha256"]',

  // Shopify-specific (anticipates subsystem C — Shopify integration)
  '*.shopify_access_token',
  '*.shopifyAccessToken',
]);

export const REDACT_CENSOR = '[REDACTED]';
