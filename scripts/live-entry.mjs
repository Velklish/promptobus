// Direct `node scripts/live-*.mjs` is the live route. An import is not.
// A proved stand leaves PATH as the stub directory, plus the suite seal when set.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STUB_BIN = 'PROMPTOBUS_STUB_BIN';
const INSTALL_DIRS = 'PROMPTOBUS_CURSOR_INSTALL_DIRS';
const PATH_SEAL = 'PROMPTOBUS_TEST_PATH_SEAL';

const USER_HARNESS_DIRS = ['.cursor', '.codex', '.claude', '.promptobus'];

export function isDirectLiveEntry(metaUrl, argv = process.argv) {
  const entry = argv[1];
  if (!entry || !metaUrl) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

export function refuseImportedEntry(metaUrl, argv = process.argv) {
  if (isDirectLiveEntry(metaUrl, argv)) return;
  const file = fileURLToPath(metaUrl);
  const error = new Error(
    `importing ${file} does not start it; node --check ${file} is the syntax check, and node ${file} is the live route`,
  );
  error.code = 'LIVE_SCRIPT_IMPORT';
  throw error;
}

function launcherName(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function canonical(file) {
  let cursor = path.resolve(file);
  const missing = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  try {
    cursor = realpathSync(cursor);
  } catch {
    // The existing prefix is already absolute.
  }
  return missing.length ? path.join(cursor, ...missing) : cursor;
}

export function resolveStubBin(name, binDir, env = process.env, probe = ['--version']) {
  const root = path.resolve(binDir);
  const launcher = path.join(root, launcherName(name));
  const bodyPath = path.join(root, `${name}.stub.mjs`);
  if (!existsSync(launcher) || !existsSync(bodyPath)) {
    return { ok: false, reason: `${name}: stub missing in ${root}; refusing to search PATH` };
  }
  let body = '';
  try {
    body = readFileSync(bodyPath, 'utf8');
  } catch (error) {
    return { ok: false, reason: `${name}: stub body unreadable (${error.message}); refusing to search PATH` };
  }
  if (!body.includes('harness')) {
    return { ok: false, reason: `${name}: stub is not a harness stand; refusing to search PATH` };
  }
  const ran = spawnSync(name, probe, {
    encoding: 'utf8',
    env: { ...env, PATH: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (ran.error || ran.status !== 0) {
    const why = ran.error?.code ?? `exit ${ran.status}`;
    return { ok: false, reason: `${name}: stub probe failed (${why}); refusing to search PATH` };
  }
  return {
    ok: true,
    path: launcher,
    bin: name,
    version: `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim(),
  };
}

export function stubHomesOutsideUser(env, keys) {
  const faults = [];
  for (const key of keys) {
    const value = env[key];
    if (!value) {
      faults.push(`${key} is unset`);
      continue;
    }
    const resolved = canonical(value);
    for (const dir of USER_HARNESS_DIRS) {
      const banned = canonical(path.join(homedir(), dir));
      if (resolved === banned || resolved.startsWith(`${banned}${path.sep}`)) {
        faults.push(`${key} is under the user home ${banned}`);
      }
    }
  }
  return faults;
}

function sealedStubPath(env, binDir) {
  const stub = path.resolve(binDir);
  const seal = env[PATH_SEAL];
  if (!seal || !existsSync(seal) || path.resolve(seal) === stub) return stub;
  return `${stub}${path.delimiter}${path.resolve(seal)}`;
}

export function guardStubLaunch(env, { names, homes }) {
  const binDir = env[STUB_BIN];
  if (!binDir) return { stub: false };
  const tools = {};
  const faults = [];
  for (const spec of names) {
    const name = typeof spec === 'string' ? spec : spec.name;
    const probe = typeof spec === 'string' ? ['--version'] : (spec.probe ?? ['--version']);
    const resolved = resolveStubBin(name, binDir, env, probe);
    if (!resolved.ok) faults.push(resolved.reason);
    else tools[name] = resolved;
  }
  faults.push(...stubHomesOutsideUser(env, homes));
  if (faults.length) return { stub: true, ok: false, reason: faults.join('; ') };
  env.PATH = sealedStubPath(env, binDir);
  env[INSTALL_DIRS] = '';
  return { stub: true, ok: true, tools };
}

export function proveStandIsolation({ binDir, names, homes, env }) {
  if (!binDir) return { ok: false, reason: 'stub bin directory is unset; refusing to search PATH' };
  const faults = [];
  for (const spec of names) {
    const name = typeof spec === 'string' ? spec : spec.name;
    const probe = typeof spec === 'string' ? ['--version'] : (spec.probe ?? ['--version']);
    const resolved = resolveStubBin(name, binDir, env, probe);
    if (!resolved.ok) faults.push(resolved.reason);
  }
  for (const [key, expected] of Object.entries(homes)) {
    const actual = env[key];
    if (!actual) faults.push(`${key} is unset`);
    else if (path.resolve(actual) !== path.resolve(expected)) {
      faults.push(`${key} is ${actual}, not the isolated home ${expected}`);
    }
  }
  faults.push(...stubHomesOutsideUser(env, Object.keys(homes)));
  if (faults.length) return { ok: false, reason: [...new Set(faults)].join('; ') };
  return { ok: true };
}
