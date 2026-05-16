/**
 * CLI entry — `pnpm cli:outbox:<subcommand>`.
 *
 * Subcommands:
 *   replay      <eventId> --reason "<text>"   — requeue a DLQ'd event
 *   dead-letter <eventId> --reason "<text>"   — force-DLQ a stuck event
 *
 * Exit codes:
 *   0 — success (transitioned to target state)
 *   1 — user error (missing/malformed args)
 *   2 — event not found
 *   3 — event already in target state (replay on non-DLQ row, or
 *       force-DLQ on already-DLQ row)
 *   4 — internal error (DB unreachable, AuditLog write failed, etc.)
 *
 * `actorId` for AuditLog is captured from `process.env.USER ??
 * process.env.USERNAME ?? 'unknown'`. The Windows fallback to USERNAME
 * matters because Windows shells expose the username through that
 * variable, not USER. Without the fallback, every operator action from
 * a Windows machine would log `actorId: 'unknown'`.
 */

import { getRequiredFlag, getRequiredPositional } from './argv.js';
import { forceDeadLetter } from './commands/dead-letter.js';
import { replayEvent } from './commands/replay.js';
import { disconnectPrisma, getPrisma } from './db.js';

const EXIT_SUCCESS = 0;
const EXIT_USER_ERROR = 1;
const EXIT_NOT_FOUND = 2;
const EXIT_ALREADY_IN_STATE = 3;
const EXIT_INTERNAL_ERROR = 4;

function getActorId(): string {
  // Windows uses USERNAME; POSIX uses USER. Try both, fall back to a
  // sentinel. Captured for forensics, not auth.
  return process.env.USER ?? process.env.USERNAME ?? 'unknown';
}

function printHelp(): void {
  // Plain text — operator audience reads it via terminal.
  process.stderr.write(
    [
      'Usage:',
      '  pnpm cli:outbox:replay      <eventId> --reason "<text>"',
      '  pnpm cli:outbox:dead-letter <eventId> --reason "<text>"',
      '',
      'Exit codes:',
      '  0 success | 1 bad args | 2 not found | 3 already in target state | 4 internal error',
      '',
    ].join('\n'),
  );
}

async function runReplay(args: readonly string[]): Promise<number> {
  const eventIdResult = getRequiredPositional(args, 0, 'eventId');
  if (!eventIdResult.ok) {
    process.stderr.write(`${eventIdResult.error.message}\n`);
    printHelp();
    return EXIT_USER_ERROR;
  }
  const reasonResult = getRequiredFlag(args, 'reason');
  if (!reasonResult.ok) {
    process.stderr.write(`${reasonResult.error.message}\n`);
    printHelp();
    return EXIT_USER_ERROR;
  }

  const prisma = getPrisma();
  try {
    const result = await replayEvent({
      prisma,
      eventId: eventIdResult.value,
      reason: reasonResult.value,
      actorId: getActorId(),
    });

    switch (result.kind) {
      case 'not_found':
        process.stderr.write(`Event ${eventIdResult.value} not found.\n`);
        return EXIT_NOT_FOUND;
      case 'not_in_dlq':
        process.stderr.write(
          `Event ${eventIdResult.value} (type=${result.event.type}) is not in DLQ state — cannot replay.\n`,
        );
        return EXIT_ALREADY_IN_STATE;
      case 'replayed':
        process.stdout.write(
          `Event ${eventIdResult.value} requeued. ` +
            `merchantId=${result.event.merchantId} type=${result.event.type} shop=${result.event.shop}\n`,
        );
        return EXIT_SUCCESS;
    }
  } finally {
    await disconnectPrisma();
  }
}

async function runDeadLetter(args: readonly string[]): Promise<number> {
  const eventIdResult = getRequiredPositional(args, 0, 'eventId');
  if (!eventIdResult.ok) {
    process.stderr.write(`${eventIdResult.error.message}\n`);
    printHelp();
    return EXIT_USER_ERROR;
  }
  const reasonResult = getRequiredFlag(args, 'reason');
  if (!reasonResult.ok) {
    process.stderr.write(`${reasonResult.error.message}\n`);
    printHelp();
    return EXIT_USER_ERROR;
  }

  const prisma = getPrisma();
  try {
    const result = await forceDeadLetter({
      prisma,
      eventId: eventIdResult.value,
      reason: reasonResult.value,
      actorId: getActorId(),
    });

    switch (result.kind) {
      case 'not_found':
        process.stderr.write(`Event ${eventIdResult.value} not found.\n`);
        return EXIT_NOT_FOUND;
      case 'already_dead_lettered':
        process.stderr.write(
          `Event ${eventIdResult.value} (type=${result.event.type}) is already dead-lettered.\n`,
        );
        return EXIT_ALREADY_IN_STATE;
      case 'dead_lettered':
        process.stdout.write(
          `Event ${eventIdResult.value} dead-lettered. ` +
            `merchantId=${result.event.merchantId} type=${result.event.type} shop=${result.event.shop}\n`,
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
    case 'replay':
      return runReplay(argv.slice(1));
    case 'dead-letter':
      return runDeadLetter(argv.slice(1));
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
    process.stderr.write(`CLI internal error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(EXIT_INTERNAL_ERROR);
  });
