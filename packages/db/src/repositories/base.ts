import { type Prisma } from '@prisma/client';

import type { WinbackPrisma } from '../client.js';
import { assertScopeMatchesMerchant } from '../tenant-scope.js';

/**
 * Base class for repositories that use raw SQL (`$queryRaw` / `$executeRaw`).
 *
 * THE PROBLEM: raw SQL bypasses the Prisma extension entirely. Tenant
 * assertion, soft-delete filtering, and AiTone validation all stop working
 * for $queryRaw / $executeRaw paths.
 *
 * THE FIX (this class): `queryRawScoped(merchantId, sql)` and
 * `executeRawScoped(merchantId, sql)` are the ONLY sanctioned entry points
 * for raw SQL in the workspace. They call `assertScopeMatchesMerchant`
 * before executing — failing fast outside the active tenant.
 *
 * THE DISCIPLINE: repositories that need raw SQL MUST extend this base
 * class and use these methods. Direct `this.prisma.$queryRaw` use outside
 * `BaseRepository` is a tenant-safety bug. A lint rule forbidding this
 * lands in M10; until then, code review is the enforcement.
 *
 * Repositories that DON'T need raw SQL don't extend this — the extension
 * covers them. Extending `BaseRepository` is itself a signal to reviewers
 * that the repository contains raw SQL.
 */
export abstract class BaseRepository {
  constructor(protected readonly prisma: WinbackPrisma) {}

  /**
   * The ONLY sanctioned `$queryRaw` entry point. Asserts that the active
   * tenant scope matches `merchantId` (or is system scope) before
   * executing. Throws `TenantScopeError` on mismatch.
   *
   * Use `Prisma.sql` template literals for parameter binding — never string
   * concatenation. The active extension is BYPASSED for raw queries; your
   * SQL is responsible for `deletedAt IS NULL` and `merchantId = $n`
   * predicates.
   */
  protected async queryRawScoped<T = unknown>(
    merchantId: string,
    query: Prisma.Sql,
  ): Promise<T[]> {
    assertScopeMatchesMerchant(merchantId);
    return this.prisma.$queryRaw<T[]>(query);
  }

  /**
   * The ONLY sanctioned `$executeRaw` entry point. Same scope-assertion
   * contract as `queryRawScoped`. Returns the number of rows affected.
   *
   * Use only when the operation cannot be expressed via the Prisma client
   * (typically: CTE-style writes, partial index-aware bulk updates).
   */
  protected async executeRawScoped(
    merchantId: string,
    query: Prisma.Sql,
  ): Promise<number> {
    assertScopeMatchesMerchant(merchantId);
    return this.prisma.$executeRaw(query);
  }
}
