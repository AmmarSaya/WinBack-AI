/**
 * CLI entry — `pnpm cli:scoring:<subcommand>`.
 *
 * Subcommands:
 *   bulk-rescore --merchant <merchantId> [--force]
 *     — run a merchant's first scoring pass (writes CustomerScore +
 *       Customer.state) WITHOUT emitting customer.state_changed events, then
 *       set scoringInitializedAt. Refuses if already initialized unless --force.
 *
 * Exit codes:
 *   0 — success (merchant rescored, scoringInitializedAt set)
 *   1 — user error (missing/malformed args)
 *   2 — merchant not found
 *   3 — merchant already initialized (re-run with --force to re-baseline)
 *   4 — internal error (DB unreachable, etc.)
 *
 * `actorId` for the AuditLog is captured from `process.env.USER ??
 * process.env.USERNAME ?? 'unknown'` — same Windows/POSIX fallback as the
 * outbox CLI (Windows exposes the username via USERNAME, not USER).
 */

import { getRequiredFlag, hasFlag } from './argv.js';
import { runBulkRescore } from './commands/bulk-rescore.js';
import { disconnectPrisma, getPrisma } from './db.js';

const EXIT_SUCCESS = 0;
const EXIT_USER_ERROR = 1;
const EXIT_NOT_FOUND = 2;
const EXIT_ALREADY_INITIALIZED = 3;
const EXIT_INTERNAL_ERROR = 4;

function getActorId(): string {
  return process.env.USER ?? process.env.USERNAME ?? 'unknown';
}

function printHelp(): void {
  process.stderr.write(
    [
      'Usage:',
      '  pnpm cli:scoring:bulk-rescore --merchant <merchantId> [--force]',
      '',
      "Runs a merchant's first scoring pass: writes CustomerScore + Customer.state",
      'for every customer WITHOUT emitting customer.state_changed events, then sets',
      'scoringInitializedAt. Refuses if already initialized unless --force',
      '(re-baseline; still emits no events).',
      '',
      'Exit codes:',
      '  0 success | 1 bad args | 2 merchant not found | 3 already initialized (use --force) | 4 internal error',
      '',
    ].join('\n'),
  );
}

async function runBulkRescoreCmd(args: readonly string[]): Promise<number> {
  const merchantResult = getRequiredFlag(args, 'merchant');
  if (!merchantResult.ok) {
    process.stderr.write(`${merchantResult.error.message}\n`);
    printHelp();
    return EXIT_USER_ERROR;
  }
  const force = hasFlag(args, 'force');

  const prisma = getPrisma();
  try {
    const result = await runBulkRescore({
      prisma,
      merchantId: merchantResult.value,
      force,
      actorId: getActorId(),
      now: new Date(),
    });

    switch (result.kind) {
      case 'merchant_not_found':
        process.stderr.write(`Merchant ${merchantResult.value} not found.\n`);
        return EXIT_NOT_FOUND;
      case 'already_initialized':
        process.stderr.write(
          `Merchant ${result.merchantId} already initialized at ${result.initializedAt.toISOString()}. ` +
            `Its first scoring pass is complete; re-running would re-baseline. ` +
            `Pass --force to re-run (still suppressed — no events emitted).\n`,
        );
        return EXIT_ALREADY_INITIALIZED;
      case 'rescored':
        process.stdout.write(
          `Merchant ${result.merchantId} rescored. ` +
            `customersScored=${String(result.customersScored)} batches=${String(result.batches)}. ` +
            `scoringInitializedAt set; no customer.state_changed events emitted.\n`,
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
    case 'bulk-rescore':
      return runBulkRescoreCmd(argv.slice(1));
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
