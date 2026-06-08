import { type WinbackPrisma, createWinbackPrisma } from '@winback/db';

/**
 * Process-singleton Prisma client for the drainer.
 *
 * The drainer is a long-running Node process. Unlike apps/web, no HMR is
 * involved — we don't need the globalThis-hoist that apps/web/db.server.ts
 * uses. Module-level memoization is sufficient.
 */

let cached: WinbackPrisma | null = null;

export function getPrisma(): WinbackPrisma {
  cached ??= createWinbackPrisma();
  return cached;
}

/** Test seam — close the cached client. Production callers should not use this. */
export async function disconnectPrisma(): Promise<void> {
  if (cached !== null) {
    await cached.$disconnect();
    cached = null;
  }
}
