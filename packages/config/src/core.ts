import { z } from 'zod';

import { defineConfig, type DefineConfigOptions } from './define.js';

export const NodeEnv = {
  Development: 'development',
  Test: 'test',
  Staging: 'staging',
  Production: 'production',
} as const;
export type NodeEnv = (typeof NodeEnv)[keyof typeof NodeEnv];

export const LogLevel = {
  Trace: 'trace',
  Debug: 'debug',
  Info: 'info',
  Warn: 'warn',
  Error: 'error',
  Fatal: 'fatal',
} as const;
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

const coreSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  SERVICE_NAME: z
    .string()
    .min(
      1,
      'SERVICE_NAME identifies this process in logs and metrics (e.g. "web", "worker.send", "worker.webhook").',
    ),
});

export type CoreConfig = z.infer<typeof coreSchema>;

let cached: CoreConfig | null = null;

export interface GetCoreConfigOptions extends DefineConfigOptions {
  /**
   * Clears the memoized value before re-parsing. Intended for tests only.
   */
  readonly reset?: boolean | undefined;
}

/**
 * Resolves the core config. Memoized — validation runs once per process.
 *
 * Application entry points MUST call this at boot, before binding ports or
 * starting workers, so misconfiguration kills the process synchronously.
 */
export function getCoreConfig(options?: GetCoreConfigOptions): CoreConfig {
  if (options?.reset === true) {
    cached = null;
  }
  if (cached === null) {
    const parseOptions: DefineConfigOptions =
      options?.source !== undefined ? { source: options.source } : {};
    cached = defineConfig(coreSchema, parseOptions);
  }
  return cached;
}

export const isProduction = (): boolean => getCoreConfig().NODE_ENV === NodeEnv.Production;
export const isStaging = (): boolean => getCoreConfig().NODE_ENV === NodeEnv.Staging;
export const isDevelopment = (): boolean => getCoreConfig().NODE_ENV === NodeEnv.Development;
export const isTest = (): boolean => getCoreConfig().NODE_ENV === NodeEnv.Test;
