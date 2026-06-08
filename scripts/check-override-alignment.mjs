#!/usr/bin/env node
// =============================================================================
// check-override-alignment.mjs — M11.x STEP F CI guardrail.
//
// Fails CI if any pnpm.overrides entry doesn't match the corresponding
// per-package dependency / devDependency / peerDependency declaration
// anywhere in the workspace.
//
// Bug class prevented: PR #66 silent no-op. A per-package devDep gets
// bumped from M to N; the pnpm.overrides entry stays at M; pnpm resolves
// to the override; the "bump" is invisible to anyone reading the lockfile.
// The drainer integration suite is the load-bearing runtime gate, but it
// shouldn't have to catch declaration-level drift — this script does.
//
// Policy:
//   - STRICT EXACT-STRING equality. A range in a per-package declaration
//     (e.g. "^4.4.3") when the override is exact ("4.4.3") is a FAIL —
//     ranges hide Dependabot-vs-override conflicts from human review.
//   - Override-only entries (no per-package consumer anywhere) PASS —
//     deliberate transitive pins are a legitimate pnpm.overrides use.
//   - Same key in both `dependencies` AND `devDependencies` of one
//     package is two independent declarations; each compared on its own.
//
// See POINTS-TO-CONSIDER.md (M11.x) for the override-sync workflow this
// guardrail enforces, and the reference sync commits 7266138 / 1393448 /
// 21b7963 for the coupled-commit pattern Dependabot can't produce.
// =============================================================================

import { readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_DIRS = ['apps', 'packages']; // mirrors pnpm-workspace.yaml
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies'];

// -----------------------------------------------------------------------------
// Pure functions — exported for unit tests.
// -----------------------------------------------------------------------------

/**
 * Discover every package.json in the workspace: root + every direct
 * child of WORKSPACE_DIRS that actually contains a package.json file.
 * Returns absolute paths. Sync because the workspace shape is small.
 */
export function discoverPackageJsons(repoRoot = REPO_ROOT) {
  const paths = [join(repoRoot, 'package.json')];
  for (const dir of WORKSPACE_DIRS) {
    const base = join(repoRoot, dir);
    let entries;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue; // dir not present — fine, just skip.
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(base, entry.name, 'package.json');
      try {
        if (statSync(candidate).isFile()) paths.push(candidate);
      } catch {
        // no package.json in this subdir — skip silently.
      }
    }
  }
  return paths;
}

/**
 * Read + parse a package.json. Throws an Error tagged with the file
 * path on either read or parse failure so the CLI catch surface can
 * attribute the failure cleanly.
 */
export async function readPackageJson(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new Error(`could not read ${filePath}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`could not parse ${filePath}: ${err.message}`);
  }
}

/**
 * Collect every (section, key, version) tuple from a package.json
 * whose key appears in `overrideKeys`. Sections scanned: dependencies,
 * devDependencies, peerDependencies.
 */
export function collectDeclarations(pkg, overrideKeys) {
  const declarations = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const block = pkg[section];
    if (!block || typeof block !== 'object') continue;
    for (const key of overrideKeys) {
      if (Object.prototype.hasOwnProperty.call(block, key)) {
        declarations.push({ section, key, version: block[key] });
      }
    }
  }
  return declarations;
}

/**
 * Compare every declaration against the overrides map.
 * Returns drift records. Strict exact-string equality — any difference
 * (including range syntax like "^x.y.z") counts as drift.
 *
 * Input shape:
 *   overrides: Record<string, string>          // override key → pinned version
 *   packages:  Array<{ file, name, json }>     // file = repo-relative path
 *
 * Output shape:
 *   Array<{ file, packageName, section, key, declared, pinned }>
 */
export function findDrifts({ overrides, packages }) {
  const overrideKeys = Object.keys(overrides);
  const drifts = [];
  for (const { file, name, json } of packages) {
    const declarations = collectDeclarations(json, overrideKeys);
    for (const decl of declarations) {
      const pinned = overrides[decl.key];
      if (decl.version !== pinned) {
        drifts.push({
          file,
          packageName: name ?? '<root>',
          section: decl.section,
          key: decl.key,
          declared: decl.version,
          pinned,
        });
      }
    }
  }
  return drifts;
}

/** Render a single drift entry as multi-line human-readable text. */
export function formatDrift(drift) {
  return (
    `  ${drift.key}\n` +
    `    pnpm.overrides (root package.json):  ${drift.pinned}\n` +
    `    ${drift.file} [${drift.section}, ${drift.packageName}]: ${drift.declared}`
  );
}

/** Build the full FAIL message including actionable fix steps. */
export function formatFailureMessage(drifts) {
  const header = `check-override-alignment: FAIL — ${drifts.length} drift(s) detected.\n`;
  const body = drifts.map(formatDrift).join('\n\n');
  const footer =
    '\n\n' +
    'How to fix:\n' +
    '  1. Decide which version is correct — the OVERRIDE or the PER-PACKAGE\n' +
    '     declaration. Usually the override (it is the authoritative pin).\n' +
    '  2. Update BOTH the pnpm.overrides entry (root package.json) AND every\n' +
    '     per-package declaration listed above so they match EXACTLY. Ranges\n' +
    '     (e.g. "^4.4.3") are NOT permitted when the override is exact —\n' +
    '     pin to the exact version, or remove the override entirely.\n' +
    '  3. Run `pnpm install` and commit the override edit + every per-package\n' +
    '     edit + pnpm-lock.yaml in the SAME commit. Dependabot cannot couple\n' +
    '     these three changes; the M11.x sync pattern is the human-led\n' +
    '     equivalent.\n' +
    '  4. Re-run `pnpm lint:overrides` locally to confirm green before push.\n' +
    '\n' +
    'See POINTS-TO-CONSIDER.md (M11.x) for the override-sync workflow this\n' +
    'guardrail enforces, and reference sync commits 7266138 / 1393448 /\n' +
    '21b7963 for the coupled-commit pattern (override + per-package devDep +\n' +
    'lockfile in one commit).\n';
  // eslint-disable-next-line @typescript-eslint/restrict-plus-operands -- `body` is inferred any from drifts.map(formatDrift).join('\n\n') in this untyped .mjs (drifts parameter has no type); the three string concatenands are runtime-strings (formatDrift returns string, header/footer are template literals). Same root as the no-unsafe-* in this file — gets relaxed in 5d.
  return header + body + footer;
}

/** Build the OK message. */
export function formatSuccessMessage({ overrideCount, packageCount }) {
  return `check-override-alignment: OK — ${overrideCount} override(s) aligned across ${packageCount} package.json files.`;
}

/**
 * Orchestrator. Returns { ok, message, drifts } for testability.
 * The CLI entrypoint handles process.exit.
 */
export async function run(repoRoot = REPO_ROOT) {
  const paths = discoverPackageJsons(repoRoot);
  const root = await readPackageJson(paths[0]);
  const overrides = root?.pnpm?.overrides ?? {};
  const overrideKeys = Object.keys(overrides);

  if (overrideKeys.length === 0) {
    return {
      ok: true,
      message: 'check-override-alignment: no pnpm.overrides — nothing to check.',
      drifts: [],
    };
  }

  const packages = [];
  for (const p of paths) {
    const json = await readPackageJson(p);
    packages.push({
      file: relative(repoRoot, p) || 'package.json',
      name: json.name,
      json,
    });
  }

  const drifts = findDrifts({ overrides, packages });
  if (drifts.length === 0) {
    return {
      ok: true,
      message: formatSuccessMessage({
        overrideCount: overrideKeys.length,
        packageCount: paths.length,
      }),
      drifts: [],
    };
  }
  return { ok: false, message: formatFailureMessage(drifts), drifts };
}

// -----------------------------------------------------------------------------
// CLI entrypoint — runs only when invoked directly, not on import.
// Guard uses pathToFileURL so it works cross-platform (Windows path
// separators vs file:// URL encoding).
// -----------------------------------------------------------------------------

const isCli =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  try {
    const { ok, message } = await run();
    if (ok) {
      console.log(message);
      process.exit(0);
    } else {
      console.error(message);
      process.exit(1);
    }
  } catch (err) {
    console.error(`check-override-alignment: FATAL — ${err.message}`);
    process.exit(1);
  }
}
