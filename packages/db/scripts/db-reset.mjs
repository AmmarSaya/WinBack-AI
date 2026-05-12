#!/usr/bin/env node
// =============================================================================
// db-reset.mjs
//
// Safeguarded wrapper around `prisma migrate reset`. Three independent
// rejection paths, each separately sufficient to block:
//
//   1. NODE_ENV must be `development` or `test`. No override.
//   2. DATABASE_URL must not match a production-host regex (unless
//      FORCE_RESET=1).
//   3. Operator must type the database name verbatim (unless FORCE_RESET=1
//      or CI=true).
//
// Production data loss requires three coincident failures. By design.
// =============================================================================

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const env = process.env.NODE_ENV;
if (env !== 'development' && env !== 'test') {
  console.error(`[db:reset] refused — NODE_ENV=${env ?? '(unset)'}.`);
  console.error('           Permitted: development | test. No override.');
  process.exit(1);
}

const url = process.env.DATABASE_URL ?? '';
if (!url) {
  console.error('[db:reset] refused — DATABASE_URL is not set.');
  process.exit(1);
}

const PROD_HOST_HINTS = /(amazonaws|supabase|neon|fly\.dev|render\.com|railway\.app|prod|production)/i;
if (PROD_HOST_HINTS.test(url) && process.env.FORCE_RESET !== '1') {
  console.error('[db:reset] refused — DATABASE_URL looks production-shaped:');
  console.error(`           ${maskUrl(url)}`);
  console.error('           Set FORCE_RESET=1 to override (NEVER do this on prod).');
  process.exit(1);
}

if (process.env.FORCE_RESET !== '1' && process.env.CI !== 'true') {
  const dbName = extractDbName(url);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `[db:reset] about to wipe ${maskUrl(url)}.\n` +
      `           Type the database name (${dbName}) to confirm: `,
  );
  rl.close();
  if (answer.trim() !== dbName) {
    console.error(
      `[db:reset] refused — confirmation "${answer.trim()}" did not match "${dbName}".`,
    );
    process.exit(1);
  }
}

const child = spawn('pnpm', ['exec', 'prisma', 'migrate', 'reset', '--force'], {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});
child.on('exit', (code) => process.exit(code ?? 0));

function maskUrl(u) {
  return u.replace(/:\/\/[^:]+:[^@]+@/, '://****:****@');
}

function extractDbName(u) {
  try {
    return new URL(u).pathname.slice(1) || '(unknown)';
  } catch {
    return '(unknown)';
  }
}
