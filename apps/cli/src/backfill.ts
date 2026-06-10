/**
 * CLI entry — `pnpm cli:backfill:<subcommand>`.
 *
 * Subcommands:
 *   orders --merchant <merchantId>
 *     — backfill a merchant's full Shopify order history into the local
 *       Order + OrderLineItem tables (resumable). Run BEFORE the first
 *       cli:scoring:bulk-rescore (or run then re-score with --force) so the
 *       cohort reflects real revenue, not account-age lurkers.
 *
 * Exit codes:
 *   0 — success (backfill completed)
 *   1 — user error (missing/malformed args)
 *   2 — merchant not found
 *   5 — backfill paused (Shopify token revoked mid-run; re-run after re-auth)
 *   4 — internal error (DB/Shopify unreachable, etc.)
 *
 * OPS: this command hits the Shopify Admin API — needs DATABASE_URL +
 * ENCRYPTION_KEY + getShopifyConfig()'s vars set in ONE shell. See
 * commands/backfill-orders.ts header.
 */

import { getRequiredFlag } from './argv.js';
import { runBackfillOrders } from './commands/backfill-orders.js';
import { disconnectPrisma, getPrisma } from './db.js';

const EXIT_SUCCESS = 0;
const EXIT_USER_ERROR = 1;
const EXIT_NOT_FOUND = 2;
const EXIT_INTERNAL_ERROR = 4;
const EXIT_PAUSED = 5;

function printHelp(): void {
  process.stderr.write(
    [
      'Usage:',
      '  pnpm cli:backfill:orders --merchant <merchantId>',
      '',
      "Backfills a merchant's full Shopify order history into the local Order +",
      'OrderLineItem tables (resumable; idempotent upserts). Does NOT trigger',
      'scoring — run cli:scoring:bulk-rescore afterward (or --force to re-score).',
      '',
      'Requires (one shell): DATABASE_URL + ENCRYPTION_KEY + the Shopify config',
      'env vars (this command calls the Shopify Admin API).',
      '',
      'Exit codes:',
      '  0 success | 1 bad args | 2 merchant not found | 5 paused (token revoked) | 4 internal error',
      '',
    ].join('\n'),
  );
}

async function runBackfillOrdersCmd(args: readonly string[]): Promise<number> {
  const merchantResult = getRequiredFlag(args, 'merchant');
  if (!merchantResult.ok) {
    process.stderr.write(`${merchantResult.error.message}\n`);
    printHelp();
    return EXIT_USER_ERROR;
  }

  const prisma = getPrisma();
  try {
    const result = await runBackfillOrders({ prisma, merchantId: merchantResult.value });

    switch (result.kind) {
      case 'merchant_not_found':
        process.stderr.write(`Merchant ${merchantResult.value} not found.\n`);
        return EXIT_NOT_FOUND;
      case 'backfilled':
        if (result.finalStatus === 'paused') {
          process.stderr.write(
            `Merchant ${result.merchantId} order backfill PAUSED (Shopify token revoked mid-run). ` +
              `pagesProcessed=${String(result.pagesProcessed)} itemsProcessed=${String(result.itemsProcessed)}. ` +
              `Re-run after the merchant re-authorizes; it resumes from the persisted cursor.\n`,
          );
          return EXIT_PAUSED;
        }
        process.stdout.write(
          `Merchant ${result.merchantId} orders backfilled. ` +
            `pagesProcessed=${String(result.pagesProcessed)} itemsProcessed=${String(result.itemsProcessed)} ` +
            `status=${result.finalStatus}. ` +
            `Run cli:scoring:bulk-rescore (--force if already initialized) to re-score against the populated cohort.\n`,
        );
        return EXIT_SUCCESS;
    }
  } finally {
    await disconnectPrisma();
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];

  switch (subcommand) {
    case 'orders':
      return runBackfillOrdersCmd(argv.slice(1));
    case '--help':
    case '-h':
    case 'help':
      printHelp();
      return EXIT_SUCCESS;
    default:
      if (subcommand === undefined) {
        process.stderr.write('No subcommand provided.\n');
      } else {
        process.stderr.write(`Unknown subcommand: ${subcommand}\n`);
      }
      printHelp();
      return EXIT_USER_ERROR;
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `CLI internal error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(EXIT_INTERNAL_ERROR);
  });
