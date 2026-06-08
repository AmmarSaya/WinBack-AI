import { type WinbackPrisma, createWinbackPrisma } from '@winback/db';

/**
 * Process-singleton Prisma client.
 *
 * Vite dev mode re-executes module top-level code on HMR. Without surviving
 * the reload, every save would create a new PrismaClient and exhaust the
 * connection pool within a few iterations. We stash on `globalThis` so the
 * client persists across HMR cycles.
 *
 * In production, this is just a lazy singleton — the global isn't touched
 * after the first call.
 */
declare global {
   
  var __winbackPrisma: WinbackPrisma | undefined;
}

export function getPrisma(): WinbackPrisma {
  globalThis.__winbackPrisma ??= createWinbackPrisma();
  return globalThis.__winbackPrisma;
}
