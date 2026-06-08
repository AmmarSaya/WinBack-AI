import { PrismaClient } from '@prisma/client';

import { winbackExtension } from './extensions/winback-extension.js';

export interface CreateWinbackPrismaOptions {
  /** Override DATABASE_URL. Most callers omit this and rely on the env var. */
  readonly url?: string;
  /** Underlying Prisma log channels; defaults to ['error', 'warn']. */
  readonly log?: ('query' | 'info' | 'warn' | 'error')[];
}

/**
 * Constructs the workspace's typed Prisma client.
 *
 * This factory is the ONLY sanctioned way to instantiate a database client
 * in the @winback platform. The raw `PrismaClient` is not exported — every
 * caller receives the extended client carrying tenant-scope enforcement,
 * soft-delete auto-filtering, and AiTone validation.
 *
 * Bypassing this factory (e.g. `new PrismaClient()` directly) defeats
 * those guarantees and is a code-review red flag.
 */
export function createWinbackPrisma(options: CreateWinbackPrismaOptions = {}): WinbackPrisma {
  const raw = new PrismaClient({
    log: options.log ?? ['error', 'warn'],
    ...(options.url !== undefined ? { datasourceUrl: options.url } : {}),
  });
  return raw.$extends(winbackExtension);
}

/** The extended client type used by every repository and application caller. */
export type WinbackPrisma = ReturnType<typeof createWinbackPrismaInternal>;

// Internal alias whose only purpose is to give the `ReturnType` above a
// nominal target. Do not export `createWinbackPrismaInternal`.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- referenced via `typeof` on line 32 for the public WinbackPrisma type; never invoked as a value
function createWinbackPrismaInternal() {
  return new PrismaClient().$extends(winbackExtension);
}
