import { type WinbackPrisma, createWinbackPrisma } from '@winback/db';

/**
 * Process-singleton Prisma client for the scheduler.
 *
 * The scheduler is a long-running Node process — no HMR concern. Module-
 * level memoization is sufficient. Same pattern as apps/drainer/src/db.ts.
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
