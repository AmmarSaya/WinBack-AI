import { type WinbackPrisma, createWinbackPrisma } from '@winback/db';

/**
 * Process-singleton Prisma client for the CLI.
 *
 * The CLI is short-lived (one command per invocation) but still benefits
 * from a single client across the command flow. `disconnectPrisma` is
 * called from the entry's `finally` block before exit.
 *
 * Mirrors the drainer / scheduler pattern. No HMR concern.
 */

let cached: WinbackPrisma | null = null;

export function getPrisma(): WinbackPrisma {
  if (cached === null) {
    cached = createWinbackPrisma();
  }
  return cached;
}

export async function disconnectPrisma(): Promise<void> {
  if (cached !== null) {
    await cached.$disconnect();
    cached = null;
  }
}
