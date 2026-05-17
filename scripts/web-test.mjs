#!/usr/bin/env node
// =============================================================================
// web-test.mjs — one-command orchestrator for apps/web integration tests.
//
// Mirrors scripts/db-test.mjs: same Docker Postgres container (port 5433,
// db winback_test) and same Redis (port 6380) via docker-compose.test.yml.
// Reuses the existing compose file — adds zero new infrastructure.
//
// Subcommands:
//   up    : build workspace → start Postgres + Redis → wait healthy → migrate
//   down  : tear down containers (and volume — wipes data)
//   run   : run integration vitest suite (assumes `up` already executed)
//   (default = "all") : up + run, leaves containers running for iteration
//
// `pnpm web:test` is the happy path.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { argv, exit, platform } from 'node:process';

const DB_URL = 'postgresql://winback:winback@localhost:5433/winback_test';
const REDIS_URL = 'redis://localhost:6380';
const COMPOSE_FILE = 'docker-compose.test.yml';
const HEALTH_TIMEOUT_MS = 30_000;
const SHELL_ON_WIN = platform === 'win32';

// Fixed test-only Shopify env. SHOPIFY_API_SECRET is the HMAC signing key
// used by both production webhook verification and the harness's
// signWebhook helper. Keep these stable — webhook signature fixtures
// implicitly depend on this value.
const TEST_SHOPIFY_ENV = {
  SHOPIFY_API_KEY: 'test_api_key',
  SHOPIFY_API_SECRET: 'test_api_secret_for_webhook_hmac_signing',
  SHOPIFY_APP_URL: 'https://test.invalid',
  SHOPIFY_SCOPES: 'read_customers,read_orders,write_discounts',
  SHOPIFY_API_VERSION: '2026-04',
  // 32 zero bytes, base64 — obviously test-shaped key for AES-256-GCM.
  // The session-token cipher (and any other ENCRYPTION_KEY consumer) needs
  // a value present; tests don't exercise real encrypted session storage.
  ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
};

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
      if (out.includes('"Health":"healthy"')) return true;
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

async function up() {
  console.log('[web:test] (1/4) building workspace…');
  let s = sh('pnpm', ['build']);
  if (s !== 0) return s;

  console.log('[web:test] (2/4) starting Postgres + Redis containers…');
  s = sh('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', 'postgres', 'redis']);
  if (s !== 0) return s;

  console.log('[web:test] (3/4) waiting for Postgres healthy…');
  if (!(await waitHealthy())) {
    console.error('[web:test] Postgres did not become healthy in time.');
    return 1;
  }

  console.log('[web:test] (4/4) applying migrations…');
  return sh(
    'pnpm',
    ['--filter', '@winback/db', 'exec', 'prisma', 'migrate', 'deploy'],
    { env: { DATABASE_URL: DB_URL } },
  );
}

function down() {
  console.log('[web:test] tearing down containers + volume…');
  return sh('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v']);
}

function run() {
  console.log('[web:test] running integration tests…');
  return sh(
    'pnpm',
    [
      '--filter',
      '@winback/web',
      'exec',
      'vitest',
      'run',
      '-c',
      'vitest.integration.config.ts',
    ],
    {
      env: {
        DATABASE_URL: DB_URL,
        REDIS_URL,
        NODE_ENV: 'test',
        SERVICE_NAME: 'web.integration',
        LOG_LEVEL: 'fatal',
        ...TEST_SHOPIFY_ENV,
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
    console.log('[web:test] integration suite green. Containers left running for iteration.');
    console.log('[web:test] tear down with `pnpm web:test:down`.');
  }
} else {
  console.error(`[web:test] unknown command: ${cmd}. Use: up | down | run | all`);
  status = 1;
}
exit(status);
