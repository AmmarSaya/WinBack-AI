import { NodeEnv, getCoreConfig } from '@winback/config';
import { pino, type Logger, type LoggerOptions } from 'pino';

import { getLogContext } from './context.js';
import { DEFAULT_REDACT_PATHS, REDACT_CENSOR } from './redaction.js';

let rootLogger: Logger | null = null;

function buildOptions(): LoggerOptions {
  const cfg = getCoreConfig();

  const base: LoggerOptions = {
    level: cfg.LOG_LEVEL,
    base: {
      service: cfg.SERVICE_NAME,
      env: cfg.NODE_ENV,
    },
    redact: {
      paths: [...DEFAULT_REDACT_PATHS],
      censor: REDACT_CENSOR,
      remove: false,
    },
    // Pino calls this synchronously per log record; we attach the current
    // AsyncLocalStorage context fields. Cost is single-digit nanoseconds.
    mixin: () => getLogContext() ?? {},
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      // Emit `"level": "info"` (string) instead of `"level": 30` (numeric).
      // Easier on human eyes and most log aggregators expect strings.
      level: (label) => ({ level: label }),
    },
  };

  if (cfg.NODE_ENV === NodeEnv.Development) {
    return {
      ...base,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
          singleLine: false,
        },
      },
    };
  }

  return base;
}

function ensureRoot(): Logger {
  if (rootLogger === null) {
    rootLogger = pino(buildOptions());
  }
  return rootLogger;
}

/**
 * Returns a logger. With no name, returns the root logger. With a `name`,
 * returns a named child carrying `{ module: name }` in every record.
 *
 * Convention: pass a dotted module path mirroring the subsystem hierarchy:
 *   getLogger('shopify.webhook')
 *   getLogger('ai.generation')
 *   getLogger('campaigns.send')
 *
 * The root logger is lazily constructed on first call so config errors
 * surface at the entry-point boundary, not at module load.
 */
export function getLogger(name?: string): Logger {
  const root = ensureRoot();
  return name === undefined ? root : root.child({ module: name });
}

export type { Logger } from 'pino';
