/**
 * `pnpm cli:scoring:bulk-rescore --merchant <merchantId> [--force]`
 *
 * Operator command to run a merchant's FIRST scoring pass (A1b / POST-EPIC-F
 * §1, Lock V10). Writes `CustomerScore` + `Customer.state` for every customer
 * WITHOUT emitting `customer.state_changed` events, then sets
 * `Merchant.scoringInitializedAt` — opening the steady-state suppression gate
 * for that merchant. The heavy lifting lives in `CustomerScoreService.bulkRescore`.
 *
 * refuse-if-initialized: if `scoringInitializedAt` is already set, the command
 * refuses (exit 3) UNLESS `--force`. This is an IDEMPOTENCY guard, not a storm
 * guard — `bulkRescore` never emits, so a `--force` re-baseline is safe (no
 * events). `--force` is therefore a plain boolean; no typed confirmation.
 *
 * Scope: the whole operation runs inside `withTenantScope(merchantId)` (the
 * refuse-check read + the pass), matching `CustomerScoreService.recompute`'s
 * caller-scoped contract.
 */

import {
  AuditLogRepository,
  CustomerScoreRepository,
  CustomerScoreService,
  type WinbackPrisma,
  withTenantScope,
} from '@winback/db';

export type BulkRescoreCommandResult =
  | { kind: 'merchant_not_found' }
  | { kind: 'already_initialized'; merchantId: string; initializedAt: Date }
  | { kind: 'rescored'; merchantId: string; customersScored: number; batches: number };

export interface RunBulkRescoreArgs {
  readonly prisma: WinbackPrisma;
  readonly merchantId: string;
  readonly force: boolean;
  readonly actorId: string;
  /** Reference instant for the pass. Defaults to `new Date()` at call time. */
  readonly now: Date;
}

export async function runBulkRescore(args: RunBulkRescoreArgs): Promise<BulkRescoreCommandResult> {
  const { prisma, merchantId, force, actorId, now } = args;

  return withTenantScope(merchantId, async () => {
    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { scoringInitializedAt: true },
    });

    if (merchant === null) {
      return { kind: 'merchant_not_found' };
    }

    // refuse-if-initialized (idempotency guard; --force bypasses).
    if (merchant.scoringInitializedAt !== null && !force) {
      return {
        kind: 'already_initialized',
        merchantId,
        initializedAt: merchant.scoringInitializedAt,
      };
    }

    const service = new CustomerScoreService(
      new CustomerScoreRepository(prisma),
      new AuditLogRepository(prisma),
    );
    const summary = await service.bulkRescore(prisma, { merchantId, now, actorId });

    return {
      kind: 'rescored',
      merchantId,
      customersScored: summary.customersScored,
      batches: summary.batches,
    };
  });
}
