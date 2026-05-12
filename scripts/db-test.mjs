#!/usr/bin/env node
// =============================================================================
// db-test.mjs — one-command orchestrator for M3-Smoke integration tests.
//
// Subcommands:
//   up    : build workspace → start Postgres container → wait healthy → migrate
//   down  : tear down container (and volume — wipes data)
//   run   : run integration vitest suite (assumes `up` already executed)
//   (default = "all") : up + run, leaves the container running for iteration
//
// `pnpm db:test` is the happy path. No README required. Single command.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { argv, exit, platform } from 'node:process';

const DB_URL = 'postgresql://winback:winback@localhost:5433/winback_test';
const COMPOSE_FILE = 'docker-compose.test.yml';
const HEALTH_TIMEOUT_MS = 30_000;
const SHELL_ON_WIN = platform === 'win32';

function sh(cmd, args, opts = {}) {
  const merged = {
    stdio: 'inherit',
    shell: SHELL_ON_WIN,
    ...opts,
    env: { ...process.env, ...(opts.env ?? {}) },
  };
  const r = spawnSync(cmd, args, merged);
  return r.status ?? 1;
}

async function waitHealthy() {
  const start = Date.now();
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    const r = spawnSync(
      'docker',
      ['compose', '-f', COMPOSE_FILE, 'ps', '--format', 'json', 'postgres'],
      { shell: SHELL_ON_WIN },
    );
    if (r.status === 0) {
      const out = r.stdout.toString();
      // `docker compose ps --format json` outputs one JSON object per line.
      if (out.includes('"Health":"healthy"')) return true;
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

async function up() {
  console.log('[db:test] (1/4) building workspace…');
  let s = sh('pnpm', ['build']);
  if (s !== 0) return s;

  console.log('[db:test] (2/4) starting Postgres container…');
  s = sh('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', 'postgres']);
  if (s !== 0) return s;

  console.log('[db:test] (3/4) waiting for Postgres healthy…');
  if (!(await waitHealthy())) {
    console.error('[db:test] Postgres did not become healthy in 30s');
    return 1;
  }

  console.log('[db:test] (4/4) applying migrations…');
  return sh(
    'pnpm',
    ['--filter', '@winback/db', 'exec', 'prisma', 'migrate', 'deploy'],
    { env: { DATABASE_URL: DB_URL } },
  );
}

function down() {
  console.log('[db:test] tearing down Postgres + volume…');
  return sh('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v']);
}

function run() {
  console.log('[db:test] running integration tests…');
  return sh(
    'pnpm',
    [
      '--filter',
      '@winback/db',
      'exec',
      'vitest',
      'run',
      '-c',
      'vitest.integration.config.ts',
    ],
    {
      env: {
        DATABASE_URL: DB_URL,
        NODE_ENV: 'test',
        SERVICE_NAME: 'db.integration',
        LOG_LEVEL: 'fatal',
      },
    },
  );
}

const cmd = argv[2] ?? 'all';
let status = 0;
if (cmd === 'up') {
  status = await up();
} else if (cmd === 'down') {
  status = down();
} else if (cmd === 'run') {
  status = run();
} else if (cmd === 'all') {
  status = await up();
  if (status === 0) status = run();
  if (status === 0) {
    console.log('[db:test] integration suite green. Container left running for iteration.');
    console.log('[db:test] tear down with `pnpm db:test:down`.');
  }
} else {
  console.error(`[db:test] unknown command: ${cmd}. Use: up | down | run | all`);
  status = 1;
}
exit(status);
