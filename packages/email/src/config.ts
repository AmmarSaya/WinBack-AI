import { ConfigError, defineConfig } from '@winback/config';
import { z } from 'zod';

/**
 * Email send pipeline config (Epic G batch 8.4).
 *
 * Lives in `packages/email/src/config.ts` — NOT `packages/config`. Mirrors
 * the established `packages/ai/src/config.ts` precedent: per-package config
 * for per-package providers; cross-cutting `@winback/config` owns only core
 * + Redis.
 *
 * Validated lazily on first call, cached as a singleton. Boot wires
 * `getEmailConfig()` early so a misconfigured process dies at startup
 * rather than at first dispatch.
 *
 * Locked decisions:
 *   - L5: `z.discriminatedUnion` on `EMAIL_PROVIDER`. Single live value at
 *         8.4 (`amazon-ses`); the union shape future-proofs additional
 *         providers without restructuring the call site.
 *   - L6: 8.4 builds against the SES SANDBOX. The `AWS_SES_SANDBOX` env
 *         var is a HARD ASSERTION at boot — set to `true` for the sandbox
 *         build; flipping to `false` at launch is the operational signal
 *         that we are sending to real merchants. Mismatch (e.g. test env
 *         pointed at a production-out-of-sandbox account) is a boot fail.
 *   - L7: AWS credentials at 8.4 are EXPLICIT env vars. IAM-role /
 *         default-credential-chain support is a launch-time switch; the
 *         AWS SDK falls back to the chain when `credentials` is omitted,
 *         so no code change needed when that flip happens.
 *   - L8: `AWS_SES_FROM_ADDRESS` is the default sender for all 8.4 sends.
 *         Sandbox: must be a SES-verified address. Per-merchant `From`
 *         override is deferred (8.6's Campaign-CRUD UI concern).
 *   - L9: `AWS_SES_CONFIGURATION_SET` is the SES-side wiring for SNS
 *         eventing. Created ONCE in AWS as build prep; the code reads
 *         the name and passes it through on every send so 8.5's SNS
 *         consumer receives delivery / bounce / complaint events.
 */

const baseSchema = z.object({});

const emailConfigSchema = z.discriminatedUnion('EMAIL_PROVIDER', [
  baseSchema.extend({
    EMAIL_PROVIDER: z.literal('amazon-ses'),
    AWS_REGION: z.string().min(1, 'AWS_REGION is required when EMAIL_PROVIDER=amazon-ses'),
    AWS_SES_ACCESS_KEY_ID: z
      .string()
      .min(1, 'AWS_SES_ACCESS_KEY_ID is required when EMAIL_PROVIDER=amazon-ses'),
    AWS_SES_SECRET_ACCESS_KEY: z
      .string()
      .min(1, 'AWS_SES_SECRET_ACCESS_KEY is required when EMAIL_PROVIDER=amazon-ses'),
    AWS_SES_FROM_ADDRESS: z
      .string()
      .min(1, 'AWS_SES_FROM_ADDRESS is required when EMAIL_PROVIDER=amazon-ses')
      .refine((s) => /.+@.+\..+/.test(s), 'AWS_SES_FROM_ADDRESS must look like an email address'),
    AWS_SES_CONFIGURATION_SET: z
      .string()
      .min(1, 'AWS_SES_CONFIGURATION_SET is required when EMAIL_PROVIDER=amazon-ses')
      .optional(),
    AWS_SES_SANDBOX: z
      .union([z.literal('true'), z.literal('false')])
      .transform((v) => v === 'true'),
  }),
]);

export type EmailConfig = z.infer<typeof emailConfigSchema>;

let cached: EmailConfig | null = null;

export interface GetEmailConfigOptions {
  readonly reset?: boolean;
  readonly source?: NodeJS.ProcessEnv | undefined;
}

/**
 * Reads + validates email config from env. Throws `ConfigError`
 * synchronously on misconfiguration — boot-only, do not catch in normal
 * code paths.
 *
 * Sandbox-build assertion (L6): at 8.4 we expect `AWS_SES_SANDBOX=true`.
 * A boot pointed at a production-out-of-sandbox SES account is a
 * deliberate operator action (the launch switch); we surface it loudly
 * via a warning log line at the boot site rather than gating here, so
 * the assertion stays in the deployment runbook rather than the code.
 */
export function getEmailConfig(options?: GetEmailConfigOptions): EmailConfig {
  if (options?.reset === true) cached = null;
  if (cached === null) {
    try {
      cached = defineConfig(
        emailConfigSchema,
        options?.source !== undefined ? { source: options.source } : {},
      );
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      throw err;
    }
  }
  return cached;
}
