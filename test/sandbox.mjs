// Shared sandbox helpers for tests. Not `*.test.mjs` — the runner
// (run.mjs) takes only those from the directory, so this file is not
// in the run.
//
// A stub binary on PATH is needed where the test takes the "external
// command found" branch: a live `claude`, `agent`, or `ast-grep` is
// not needed, and its answer must be set. The helper was used seven
// times, and six of them were written as `#!/bin/sh` with no
// extension — on Windows such a file is not found at all:
// `resolveCommand` searches PATH × PATHEXT, and a file without
// `.exe`/`.cmd`/`.bat` is not in that walk. So the test went red there
// on sound code and taught people to treat red as normal.
//
// The fix is not translating the script to batch: the scripts branch
// on argv, read stdin, and write files, and two dialects would drift
// on the first edit. The script is written once in JS and run by
// node; what stays platform-specific is a three-line launcher —
// `.cmd` on win32, `#!/bin/sh` on POSIX.
//
// The cost is a node start on every stub-binary call, and that is not
// fractions of a second. Measured on this machine 2026-08-30, 80 calls
// per variant: a call costs about 71 ms, of which 55–66 ms is an empty
// node start (`node -e ''`), 3–6 ms is the launcher `sh` process,
// 5–10 ms is the ESM loader versus CJS. Stub binaries are called
// hundreds of times per suite run; the most —
// `promptobus-review.test.mjs`, the longest suite file (file timeout
// and spread — [run.mjs](run.mjs)).
//
// The launcher can be made cheaper, but only a little, and the edit
// costs more than the gain. Same measurement: a node shebang instead
// of `sh` (`#!<node>`, file with no extension) removes only the `sh`
// process and does not even give it to an ESM body — 69 ms versus 71;
// the same shebang with a `.cjs` body also drops the ESM loader —
// 61 ms, i.e. 10 ms per call. Those 10 ms would be paid for with a
// second launcher form on POSIX and a body split by syntax: `import`
// is in 9 of 52 `stubCommand` calls, the rest would take `.cjs`. The
// ceiling of the gain is 3.5 s CPU per suite run and 0.7 s wall-clock
// on the pool critical path, i.e. less than the run wanders from
// machine neighbours. Hence the decision: not done.
//
// The node start itself — 55–66 ms of 71 — is not removed by anything
// except one long-lived stub. That is forbidden for another reason,
// and it has nothing to do with `.cjs`: the socket client is no longer
// written in JS, and `.cmd` with `#!/bin/sh` would drift not in three
// lines but in two different programs — exactly the problem the script
// was unified onto one language to avoid.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
// Static CLI import — before HOME hygiene in home.mjs and before the
// swap in the suite file. A module that computes os.homedir() into a
// load-time constant would see the real home (home paths are computed
// at call time; the class is caught by homedir-module.test.mjs).
import { resetBgSessionsCache } from '../lib/liftoff.js';
import { claudeDriver } from '../lib/driver-claude.js';
import { addressOf } from '../lib/store.js';

// Reset of CLI process memory: the suite swaps PATH, the stub-binary
// body, and the "session is up" marker, and without a reset the cache
// would return the answer from before the edit.
export function resetCliCaches() {
  resetBgSessionsCache();
}

// Stub command `name` in directory `dir`. `body` is an ESM-script
// body: arguments arrive in `process.argv.slice(2)`, stdin is read as
// usual, the exit code is set with `process.exitCode` or
// `process.exit`.
//
// `platform` is set explicitly only so the win32 form can be checked
// from a POSIX machine (exec.test.mjs): the whole point of the fix is
// that on Windows the file must have a PATHEXT extension, and there
// is nowhere to run the suite there today.
export function stubCommand(dir, name, body, { platform = process.platform } = {}) {
  mkdirSync(dir, { recursive: true });
  const script = path.join(dir, `${name}.stub.mjs`);
  writeFileSync(script, body.endsWith('\n') ? body : `${body}\n`);
  if (platform === 'win32') {
    // CRLF line endings and `%*` whole: cmd.exe parses a batch file
    // line by line, and forwards arguments as-is — the caller already
    // did the quoting.
    writeFileSync(path.join(dir, `${name}.cmd`), `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    writeFileSync(path.join(dir, name),
      `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
  // The binary body changed: the former `--version` / `agents --json`
  // is no longer true.
  resetCliCaches();
  return script;
}

// Sandbox PATH: the directory with stub binaries ahead of the system
// one. Returns a restore function — PATH is one for the whole test
// process, and left swapped it leaks into neighbouring branches of
// the same file. `only` cuts the system PATH entirely: that is how
// the "command is not on PATH" branch is set, and the empty directory
// for it must be real — an empty string in PATH means different
// things on win32 and on POSIX.
export function withStubPath(dir, { only = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const before = process.env.PATH;
  process.env.PATH = only ? dir : `${dir}${path.delimiter}${before}`;
  resetCliCaches();
  return () => { process.env.PATH = before; resetCliCaches(); };
}

// Session snapshot from a stub harness answer — the state-machine
// input and the print seam. One home for the whole suite: copies in
// three files had already drifted — one had a `null` guard, the other
// two did not — and they must not drift, for the same reason
// `participantFileStem` has one home.
//
// The snapshot is built by the REAL Claude driver: checking the state
// machine against a homemade layout would test the fixture, not the
// parse production lives on. Nobody touches a live `claude` — the
// list arrives as a fixture.
//
// `list === null` kills the snapshot ENTIRELY, the way
// `snapshotSessions` kills it on the first `null` (driver.ts): the
// mechanism never has a half snapshot, and one must not be fed to
// the suite.
export function snapshotOfList(participants, list) {
  if (list === null) return null;
  return Object.fromEntries((participants ?? [])
    .filter((p) => p.sessionRef)
    // Snapshot key — the participant ADDRESS: health, contact points,
    // and stop marks are keyed by it too, and a person reads it. The
    // address is written by the adapter and lives in the `metadata`
    // field (`addressOf`); the v1 record's own fields are role,
    // harness, mode, session reference, and the capabilities snapshot.
    .map((p) => [addressOf(p), claudeDriver.inspect(p.sessionRef, list)]));
}

// Per-file sandbox with cleanup on process exit. A `mkdtempSync` at
// the file tail is not saved by a matching `rmSync`: the run that
// leaves the garbage is exactly the one that never reaches it — a
// failed check takes the process through `process.exit` from
// `fail()`, and Ctrl+C does not even get that far. The `exit` hook
// fires in both cases; signals are covered separately.
//
// Under `npm test` the directory already lives inside the run
// directory, which the runner removes ([run.mjs](run.mjs)); this
// helper is for running one file by hand — i.e. debugging, where
// failures and interrupts actually happen.
const sandboxes = [];
let hooked = false;
// The real exit is captured at module load: suite files swap
// `process.exit` with a thrower to catch `fail()` refusals
// (install.test.mjs), and a signal hook would call the swapped one —
// instead of code 130 there would be an unhandled exception.
const exit0 = process.exit;

function keepUntilExit(dir) {
  sandboxes.push(dir);
  if (!hooked) {
    hooked = true;
    const clean = () => { for (const d of sandboxes.splice(0)) rmSync(d, { recursive: true, force: true }); };
    process.on('exit', clean);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(sig, () => { clean(); exit0.call(process, 130); });
    }
  }
  return dir;
}

export function makeSandbox(prefix) {
  return keepUntilExit(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Standalone host config for a sandbox workspace: tools live in promptobus.json. */
export function writeHostConfig(dir, config = {}) {
  mkdirSync(dir, { recursive: true });
  const body = {
    commandName: 'promptobus',
    tools: ['claude', 'cursor', 'codex'],
    ...config,
  };
  writeFileSync(path.join(dir, 'promptobus.json'), `${JSON.stringify(body)}\n`);
}

/** PATH lookup for live scripts. Standalone host.resolveToolBin does not search install dirs. */
export function resolveToolBin(name) {
  const r = spawnSync(name, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) {
    return { ok: false, reason: `${name}: not found on PATH`, bin: name };
  }
  return { ok: true, path: name, bin: name, version: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

export const AST_GREP_INSTALL = 'npm install -g @ast-grep/cli';

/** Locate ast-grep on PATH or common install prefixes. Missing binary is a red gate, not a skip. */
export function findAstGrep({ env = process.env, home = os.homedir() } = {}) {
  const r = spawnSync('ast-grep', ['--version'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!r.error) return 'ast-grep';
  const extras = [
    '/opt/homebrew/bin/ast-grep',
    '/usr/local/bin/ast-grep',
    path.join(home, '.npm-global', 'bin', 'ast-grep'),
  ];
  for (const candidate of extras) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (!probe.error) return candidate;
  }
  return null;
}

// Test socket path — whole, including the root choice. The helper
// returns a builder `name → path`, not a directory: a directory is
// meaningless on Windows — a socket there is a named pipe and does
// not occupy the filesystem at all — and a helper that returned a
// temp directory there would lock in a trap for a third caller.
//
// Why a private root on POSIX. A unix-socket full path is limited to
// about 104 bytes (`sun_path`), and under `npm test` the temp
// directory is diverted into the run directory ([run.mjs](run.mjs))
// and itself takes about seventy-five characters. `listen` on a long
// path fails with `EINVAL`, and it fails not as a check but as an
// unhandled event: the test file dies whole. Alone the same file
// passes — system `/var/folders/…/T` is shorter than the run
// directory by exactly enough to fit. In one run this was stepped on
// twice, in `promptobus-warden.test.mjs` and `doctor.test.mjs`, and
// the helper lived as a copy in both.
//
// Measured on this machine 2026-08-29: `/tmp/adoc-XXXXXX/live.sock`
// is 26 characters, the same socket under the run directory is 97,
// and with the former directory name `ati-a2a-sock-` — 105, i.e. over
// the limit. A short directory name gives an eight-character margin
// and is held by the length of a foreign `TMPDIR`; a short root gives
// seventy-eight and does not depend on the machine. The helper
// bypasses the run `TMPDIR` on purpose, so the directory is removed
// not by the runner but by the same exit hooks as a sandbox.
export function makeSockPath(prefix) {
  return makeSockDir(prefix).sock;
}

// The same, but with the directory: whoever cleans up after itself
// needs to remove it — a live run in its `finally`
// ([live-e2e.mjs](../scripts/live-e2e.mjs)). The directory must not
// be derived from the path builder: on win32 the builder returns
// `\\.\pipe\…`, and `rmSync` on such a "directory" would walk the
// named-pipe namespace (review note). So the directory is a separate
// field, and on win32 it is not there at all — `null`.
export function makeSockDir(prefix) {
  if (process.platform === 'win32') {
    return { dir: null, sock: (name) => `\\\\.\\pipe\\${prefix}${process.pid}-${name}` };
  }
  const dir = keepUntilExit(mkdtempSync(path.join('/tmp', prefix)));
  return { dir, sock: (name) => path.join(dir, `${name}.sock`) };
}
