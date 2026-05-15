#!/usr/bin/env node
// =============================================================================
// queue-test.mjs — one-command orchestrator for @winback/queue integration
// tests against real Redis.
//
// Subcommands:
//   up    : build workspace → start Redis container → wait healthy (PING)
//   down  : tear down Redis container (does NOT touch Postgres)
//   run   : run integration vitest suite (assumes `up` already executed)
//   (default = "all") : up + run, leaves the container running for iteration
//
// `pnpm queue:test` is the happy path. No README required. Single command —
// parallel structure to scripts/db-test.mjs.
//
// Health check (Checkpoint 1):
//   The PING is dispatched via `docker compose exec` rather than via a bare
//   `redis-cli` on the host. The host's PATH may not contain redis-cli
//   (especially on Windows), but the redis container always carries the
//   redis-cli binary inside. `-T` disables pseudo-TTY allocation, which
//   would fail in this non-interactive subprocess context.
//   30 attempts × 1s sleep = 30s ceiling, matching the vitest integration
//   testTimeout/hookTimeout.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { argv, exit, platform } from 'node:process';

// Shared env injected into every child process the script spawns — both the
// `pnpm build` step in up() and the vitest command in run(). Keeping it in
// one place means a single source of truth for the integration suite's
// environment; a future addition (e.g. a feature flag, a tracing endpoint)
// lands here once instead of being duplicated across spawn sites.
const baseEnv = {
  REDIS_URL: 'redis://localhost:6380',
  NODE_ENV: 'test',
  SERVICE_NAME: 'queue.integration',
  LOG_LEVEL: 'fatal',
};

const COMPOSE_FILE = 'docker-compose.test.yml';
const HEALTH_ATTEMPTS = 30;
const HEALTH_INTERVAL_MS = 1000;
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
  for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++) {
    const r = spawnSync(
      'docker',
      [
        'compose',
        '-f',
        COMPOSE_FILE,
        'exec',
        '-T',
        'redis',
        'redis-cli',
        'ping',
      ],
      { shell: SHELL_ON_WIN },
    );
    if (r.status === 0) {
      const out = r.stdout.toString().trim();
      if (out === 'PONG') return true;
    }
    if (attempt < HEALTH_ATTEMPTS) {
      await new Promise((res) => setTimeout(res, HEALTH_INTERVAL_MS));
    }
  }
  return false;
}

async function up() {
  console.log('[queue:test] (1/3) building workspace…');
  // baseEnv injected for env-consistency across the entire script
  // lifecycle — the build step doesn't need it, but propagating the same
  // env to every spawn closes the "did the worker boot with different env
  // than the build saw" class of subtle bugs at zero cost.
  let s = sh('pnpm', ['build'], { env: { ...baseEnv } });
  if (s !== 0) return s;

  console.log('[queue:test] (2/3) starting Redis container…');
  s = sh('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', 'redis']);
  if (s !== 0) return s;

  console.log('[queue:test] (3/3) waiting for Redis PING…');
  if (!(await waitHealthy())) {
    console.error(
      `[queue:test] Redis did not respond to PING within ${HEALTH_ATTEMPTS}s`,
    );
    return 1;
  }
  console.log('[queue:test] Redis healthy (PONG received).');
  return 0;
}

function down() {
  console.log('[queue:test] removing Redis container…');
  // -s stops the running container first, then removes it. We do NOT use
  // `docker compose down` which would also tear down Postgres — pnpm db:test
  // and pnpm queue:test manage their own lifecycles independently.
  return sh('docker', [
    'compose',
    '-f',
    COMPOSE_FILE,
    'rm',
    '-f',
    '-s',
    'redis',
  ]);
}

function run() {
  console.log('[queue:test] running integration tests…');
  return sh(
    'pnpm',
    [
      '--filter',
      '@winback/queue',
      'exec',
      'vitest',
      'run',
      '-c',
      'vitest.integration.config.ts',
    ],
    { env: { ...baseEnv } },
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
    console.log(
      '[queue:test] integration suite green. Container left running for iteration.',
    );
    console.log('[queue:test] tear down with `pnpm queue:test:down`.');
  }
} else {
  console.error(
    `[queue:test] unknown command: ${cmd}. Use: up | down | run | all`,
  );
  status = 1;
}
exit(status);
