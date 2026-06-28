/**
 * CLI entry — `pnpm cli:dispatch:<subcommand>`.
 *
 * Subcommands:
 *   smoke --to <verified-address> [--subject <s>] [--body <html>]
 *     — sends ONE email via the real SES adapter pointed at the SANDBOX, to a
 *       SES-verified test address. Confirms the adapter actually talks to SES
 *       (env, credentials, configuration set, region). NO DB writes. Run once
 *       when 8.4 lands and after any SES env change.
 *
 * Exit codes:
 *   0 — success (smoke sent; providerMessageId on stdout)
 *   1 — user error (missing/malformed args)
 *   3 — sandbox guard failed (`AWS_SES_SANDBOX` is not `true` — refuse to send)
 *   4 — internal error (SES throw, config error, etc.)
 *
 * OPS: requires the email-config env in ONE shell — see
 * commands/dispatch-smoke.ts header.
 */

import { getRequiredFlag, getFlag } from './argv.js';
import { runDispatchSmoke } from './commands/dispatch-smoke.js';

const EXIT_SUCCESS = 0;
const EXIT_USER_ERROR = 1;
const EXIT_SANDBOX_REQUIRED = 3;
const EXIT_INTERNAL_ERROR = 4;

function printHelp(): void {
  process.stderr.write(
    [
      'Usage:',
      '  pnpm cli:dispatch:smoke --to <verified-address> [--subject <s>] [--body <html>]',
      '',
      'Sends ONE email via the real SES adapter pointed at the SANDBOX. NO DB writes.',
      'Refuses to run unless AWS_SES_SANDBOX=true (8.4 build assumption).',
      '',
      'Requires (one shell): EMAIL_PROVIDER + AWS_REGION + AWS_SES_ACCESS_KEY_ID +',
      'AWS_SES_SECRET_ACCESS_KEY + AWS_SES_FROM_ADDRESS + AWS_SES_CONFIGURATION_SET',
      '+ AWS_SES_SANDBOX=true.',
      '',
      'Exit codes:',
      '  0 success | 1 bad args | 3 sandbox required (AWS_SES_SANDBOX!=true) | 4 internal error',
      '',
    ].join('\n'),
  );
}

async function runDispatchSmokeCmd(args: readonly string[]): Promise<number> {
  const toResult = getRequiredFlag(args, 'to');
  if (!toResult.ok) {
    process.stderr.write(`${toResult.error.message}\n`);
    printHelp();
    return EXIT_USER_ERROR;
  }

  const subject = getFlag(args, 'subject') ?? undefined;
  const bodyHtml = getFlag(args, 'body') ?? undefined;

  const result = await runDispatchSmoke({
    to: toResult.value,
    ...(subject !== undefined ? { subject } : {}),
    ...(bodyHtml !== undefined ? { bodyHtml } : {}),
  });

  switch (result.kind) {
    case 'sandbox_required':
      process.stderr.write(
        'AWS_SES_SANDBOX is not true. The 8.4 smoke command refuses to run outside the sandbox to avoid an accidental production send.\n',
      );
      return EXIT_SANDBOX_REQUIRED;
    case 'sent':
      process.stdout.write(
        `SES smoke sent. providerMessageId=${result.providerMessageId} latencyMs=${String(result.latencyMs)}\n`,
      );
      return EXIT_SUCCESS;
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];

  switch (subcommand) {
    case 'smoke':
      return runDispatchSmokeCmd(argv.slice(1));
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
