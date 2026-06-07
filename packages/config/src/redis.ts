import { z } from 'zod';

import { defineConfig, type DefineConfigOptions } from './define.js';

/**
 * @winback/config — Redis configuration.
 *
 * Strict env-var validation for the Redis connection used by @winback/queue
 * (BullMQ) and any future cache consumer. Validation runs synchronously at
 * boot via `defineConfig`; misconfiguration kills the process before any
 * worker binds a port. Per the @winback/config-wide contract: no lazy
 * failure modes, no defaults that mask missing variables.
 *
 * URL scheme is the TLS trigger (ioredis convention):
 *   redis://  — plaintext TCP. Dev, internal-only deployments, sidecar
 *               containers on the same host.
 *   rediss:// — TLS. Production managed Redis (ElastiCache with in-transit
 *               encryption, Upstash, Redis Cloud, Heroku Redis Premium).
 *
 * Certificate validation defaults to ON. Operators may override with
 * REDIS_TLS_REJECT_UNAUTHORIZED=false ONLY in non-production environments.
 * In production the validator REFUSES the override at boot — a deploy that
 * intends to disable TLS cert validation in production requires a code
 * change here (relaxing the policy), not just an env flag.
 *
 * Why this policy:
 *   - Managed Redis providers all ship CA-signed certs; the default Just
 *     Works for the 99% case. The override is for the rare self-signed
 *     scenario, which is overwhelmingly a non-production thing.
 *   - Standing rule 15: "if correctness depends on a human remembering, it
 *     will eventually fail." Letting a single env flag flip silently
 *     disable TLS validation in production is exactly that class of
 *     latent risk. Requiring a code change forces a review.
 *
 * Footgun avoided — DO NOT use `z.coerce.boolean()` here. JavaScript's
 * `Boolean("false") === true` means coercion would silently turn the
 * string "false" into boolean `true`, the opposite of operator intent.
 * The enum+default+transform pattern below is strict (rejects anything
 * other than literal "true" or "false") and yields a real boolean.
 *
 * NODE_ENV is read by this schema solely for the production-policy check.
 * It is stripped from the returned value via the outer transform so
 * consumers don't accidentally use this object as a NODE_ENV source.
 */

const REDIS_URL_SCHEMA = z
  // zod 4: `z.url(msg)` is the new top-level form; replaces the deprecated
  // chainable `z.string().url(msg)`. Both call into core._url(ZodURL,...)
  // with identical validation semantics — `z.url()` returns ZodURL (a
  // ZodStringFormat subtype) so the `.refine(...)` chain below still works.
  .url('REDIS_URL must be a valid URL.')
  .refine(
    (v) => v.startsWith('redis://') || v.startsWith('rediss://'),
    {
      message:
        'REDIS_URL must use redis:// (plaintext) or rediss:// (TLS) scheme.',
    },
  );

const REDIS_TLS_REJECT_UNAUTHORIZED_SCHEMA = z
  .enum(['true', 'false'])
  .default('true')
  .transform((v) => v === 'true');

const redisSchema = z
  .object({
    REDIS_URL: REDIS_URL_SCHEMA,
    REDIS_TLS_REJECT_UNAUTHORIZED: REDIS_TLS_REJECT_UNAUTHORIZED_SCHEMA,
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),
  })
  .superRefine((data, ctx) => {
    if (
      data.NODE_ENV === 'production' &&
      !data.REDIS_TLS_REJECT_UNAUTHORIZED
    ) {
      ctx.addIssue({
        // zod 4: `ZodIssueCode` is deprecated in favor of the raw string
        // literal. `ZodIssueCode.custom === 'custom'` at runtime; pure
        // value-for-reference swap, no semantic change to the issue emitted.
        code: 'custom',
        path: ['REDIS_TLS_REJECT_UNAUTHORIZED'],
        message:
          'REDIS_TLS_REJECT_UNAUTHORIZED=false is refused in production. ' +
          'Use a managed Redis with a CA-signed certificate, or change NODE_ENV. ' +
          'Disabling TLS validation in production requires a code change, not an env flag.',
      });
    }
  })
  // Strip NODE_ENV from the returned shape — we read it only for the policy
  // check above. Consumers of RedisConfig should not be peeking at NODE_ENV
  // through this object; that's getCoreConfig's job.
  .transform((data) => ({
    REDIS_URL: data.REDIS_URL,
    REDIS_TLS_REJECT_UNAUTHORIZED: data.REDIS_TLS_REJECT_UNAUTHORIZED,
  }));

export type RedisConfig = z.infer<typeof redisSchema>;

let cached: RedisConfig | null = null;

export interface GetRedisConfigOptions extends DefineConfigOptions {
  /**
   * Clears the memoized value before re-parsing. Intended for tests only.
   */
  readonly reset?: boolean | undefined;
}

/**
 * Resolves the Redis config. Memoized — validation runs once per process.
 *
 * Application entry points (worker bootstrap, web app boot) MUST call this
 * alongside `getCoreConfig` before binding ports or starting workers, so
 * misconfiguration kills the process synchronously rather than failing on
 * first Redis connect (which would be silent in a worker, late in the web
 * app, and either way harder to debug than a synchronous boot failure).
 */
export function getRedisConfig(options?: GetRedisConfigOptions): RedisConfig {
  if (options?.reset === true) {
    cached = null;
  }
  if (cached === null) {
    const parseOptions: DefineConfigOptions =
      options?.source !== undefined ? { source: options.source } : {};
    cached = defineConfig(redisSchema, parseOptions);
  }
  return cached;
}
