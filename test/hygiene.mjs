// The list of "what the suite must not touch" — one place for every
// use. Not `*.test.mjs` — the runner (run.mjs) takes only those from
// the directory, so this file is not in the run.
//
// Four readers. The runner [run.mjs](run.mjs) builds the environment
// for each file of the run; [home.mjs](home.mjs) covers running one
// file by hand — i.e. debugging, where there is no runner at all —
// and every suite file imports it, the verdict helper
// [check.mjs](check.mjs) included; and the live scripts —
// [live-e2e.mjs](../scripts/live-e2e.mjs),
// [live-canary.mjs](../scripts/live-canary.mjs) and
// `release-gates.mjs` — strip session
// identity from the environment they give their children
// (`dropSessionLeaks`). While the list lived as a copy in two places,
// the pair was fixed separately twice: the warden switch and home;
// and the live scripts were not fixed at all — they were run exactly
// from sessions that have all five variables set. Checking copies
// with a gate costs more than not making a second one: the list is
// short, every use needs the same one, and they differ not in
// membership but in how it is applied — the runner builds a child
// environment, the helper edits its own, the scripts drop five names
// and do not touch home (a live run needs the real one).
//
// What is on the list and why:
//
// - **warden auto-lift** (`PROMPTOBUS_WARDEN=off`). The suite runs
//   real bus commands, and those raise a task listener as a detached
//   process — it outlives both the test file and the whole run. Live
//   measure 2026-08-29: one run left six such processes, and they
//   started waking the developer's session at addresses from fixtures.
//   Cleanup in the test does not fix this: the process is detached by
//   construction;
// - **contact point of this session** (`CLAUDE_CODE_MESSAGING_SOCKET`/
//   `_TOKEN`). A bus command hands the task store the socket address
//   of its session, and under a test its session is the session of the
//   developer who started `npm test`. A fixture would get a live
//   person's real socket;
// - **user home** (`HOME`/`USERPROFILE`). The suite starts the real
//   CLI as a child process, and `sync` at the tail installs memory
//   hooks into home — not into the project. If the home layout
//   diverges from the shipped one (and it diverges on any edit of
//   `cli/memory-hooks`) — a green run rewrites the person's
//   `~/legacy/memory-hooks` and `~/.claude/settings.json`. Live trace
//   2026-08-29: a `settings.json.bak.20260829224155` backup after a
//   worker run, invisible as a leak in the run results. The swap is
//   shared, not in individual files: `root.test.mjs` spawns the CLI
//   on purpose, and `cli-flags.test.mjs` and `setup.test.mjs` only
//   hold because they refuse before the `sync` tail — a point patch
//   would close one file of three and stay silent about a fourth;
// - **memory-hook lever** (`CONTEXT_STORE_*`). The ATI-host
//   `extraEnv` sets `CONTEXT_STORE_STOP_GATE=0` on every bus
//   participant — under a worker and a reviewer the variable is in
//   the session environment before `npm test`. The suite calls real
//   hooks with `spawnSync`, not a stub binary, and a leaked variable
//   kills the gate in the hook child process by the same official
//   lever, not by a test bypass;
// - **bus identity** (`PROMPTOBUS_ROLE`/`PROMPTOBUS_TASK`/
//   `PROMPTOBUS_HOME`). The same class as the memory lever, and the
//   same reason: `sessionEnv` in spawn.js puts this triple on every
//   bus participant, so under a worker and a reviewer it is in the
//   session environment before `npm test`. The suite calls real bus
//   commands with `spawnSync`, and `PROMPTOBUS_HOME` beats a home
//   search from cwd (`resolveIdentity`) — a leaked variable would
//   send the run into the LIVE bus journal of the workspace, and
//   `PROMPTOBUS_ROLE` and `PROMPTOBUS_TASK` would give the commands
//   a foreign identity. Measured 2026-09-02: suite files that spawn
//   the CLI with `...process.env` and do not set their own
//   `PROMPTOBUS_HOME` — four: `doctor`, `promptobus-review`, `tools`,
//   `util`;
// - **Claude Code config directory** (`CLAUDE_CONFIG_DIR`). Participant
//   stall parse (`sessionStall` → `sessionDetail` in driver-claude.js)
//   reads `<CLAUDE_CONFIG_DIR>/jobs/<id>/state.json`, and without the
//   variable — `~/.claude` from home. Home is diverted for the suite,
//   but the variable stands in the mechanism worker session
//   environment (the harness puts it there), and leaked it would send
//   the parse into the state of a person's live sessions — where the
//   suite file did not plant a directory itself. It is diverted to
//   the same place as home: `<run home>/.claude`; without a home —
//   dropped.

//
// The list has a second half that is not a variable at all — **PATH**. Sandboxing
// `HOME` and `TMPDIR` seals nothing by itself: a child process escapes through PATH.
// Live case 2026-09-04: a driver test hung because `spawn` resolved the declared tool
// name through the standalone host, which hands the name back without searching, and
// `run('cursor')` then found the operator's own `~/.local/bin/cursor` and waited on
// `cursor mcp enable`. The stand had stubbed `agent`, the name the driver documents,
// so nothing intercepted `cursor`. Nothing detectable was damaged, and that was luck
// about which subcommand ran, not a property of the suite (PB-2).
//
// So the suite runs with PATH SEALED: one directory, holding a symlink per binary the
// suite is allowed to reach, and nothing else. A name nobody stubbed does not resolve
// — the spawn fails with ENOENT and names the command instead of launching whatever
// the operator has installed. Stub directories are PREPENDED to that
// (`withStubPath` in [sandbox.mjs](sandbox.mjs)), and suite files that compose their
// own `${BIN}${delimiter}${PATH}` compose it from the sealed one they were handed, so
// one seal covers every file without an edit in any of them.

import { existsSync, mkdirSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Auto-lift switch: the variable name and its value under the suite.
const WARDEN_SWITCH = 'PROMPTOBUS_WARDEN';
const WARDEN_OFF = 'off';
// Contact point of this session: these variables are dropped, not
// swapped — the suite has no stub socket, and an empty address is
// more honest than a foreign one.
const MESSAGING_VARS = ['CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN'];
// Home: POSIX looks at `HOME`, Windows at `USERPROFILE`, and swapping
// only one of the two would leave a hole on the other platform
// entirely.
export const HOME_VARS = ['HOME', 'USERPROFILE'];
// Memory-hook lever (`CONTEXT_STORE_STOP_GATE=0` and neighbours):
// the ATI-host `extraEnv` sets it on every bus participant, and under
// a worker or a reviewer it leaks into the hook child process — the
// suite calls real hooks with `spawnSync`, not a stub binary. A
// prefix, not one variable: the family is one (URL, HOME, DISABLE),
// and any of them leaks the same way.
const CONTEXT_STORE_PREFIX = 'CONTEXT_STORE_';
// Participant bus identity: dropped, not swapped — suite files that
// declare their own home and task do so themselves, and those that
// do not are more honest without a home, resolving it from the
// sandbox cwd. A named list, not a `PROMPTOBUS_` prefix: that prefix
// also covers the warden switch and the canary roots, which have
// their own rules.
//
// The list now has one home — this one. A second copy lived in
// `spawn.js` (`IDENTITY_VARS`) while `sessionEnv` put the triple into
// the environment of the raised session; a gate of equality held them
// together. Identity moved into Stop-hook command arguments, putting
// it in the environment stopped, and the copy went — with the gate.
// The triple must still be dropped: the harness DAEMON puts it into
// the session environment, from a foreign run.
export const IDENTITY_VARS = ['PROMPTOBUS_ROLE', 'PROMPTOBUS_TASK', 'PROMPTOBUS_HOME'];
// Claude Code config directory: diverted with home, not only dropped
// — an explicit path is visible to a stub suite file, and the verdict
// checks it against the run home.
const CONFIG_DIR_VAR = 'CLAUDE_CONFIG_DIR';
// Root of the mechanism under test and a ready workspace. Only the
// release canary sets them; left in a developer's environment after a
// manual run, they silently send the whole suite onto a FOREIGN tree
// — the script resolves the binary, the store, and the driver from
// them. Red from there would talk about a stranger's directory, and
// green would mean nothing about the checkout. The same leak class
// the list was created for.
const E2E_PREFIX = 'PROMPTOBUS_E2E_';

/**
 * Binaries the suite may reach on the machine, and why each is here. The list is
 * short on purpose: every name on it is a name a test can call without stubbing,
 * and the whole point of the seal is that the set of those names is closed and
 * written down.
 *
 * - `node` — `npm` and every `#!/usr/bin/env node` script it runs resolve the
 *   interpreter through PATH. The suite's own children get `process.execPath`, an
 *   absolute path, and do not need this;
 * - `npm` — `promptobus-package.test.mjs` runs the nested package suite as a child
 *   `npm test --prefix …`, and `installWorktreeDeps` runs `npm ci`;
 * - `git` — clones, worktrees and diffs, in a dozen files;
 * - `sh` — the POSIX stub launcher is `#!/bin/sh`, and `spawnSync('sh', …)` is used
 *   directly; `env` — the Cursor launch script is `exec env -u … <bin>`;
 * - `ps`, `pgrep` — the process reads the suite makes about ITSELF (the register of
 *   them is in [run.mjs](run.mjs));
 * - `tar` — the packaging check unpacks what `npm pack` produced;
 * - `sleep` — shell fixtures hold a pipe open with it. Measured 2026-09-05: without
 *   it the deadline check in `model-routing-adapter-claude.test.mjs`, whose stub
 *   binary is `#!/bin/sh` + `sleep 5`, became a coin flip — the fixture exited 127
 *   instead of holding, and the verdict raced the deadline (one red in three runs of
 *   the file, and one in six full concurrent runs);
 * - `ast-grep` — the ambient gate refuses rather than skips when it is missing, so
 *   it must be reachable.
 *
 * Deliberately absent: `claude`, `cursor`, `cursor-agent`, `agent`, `codex`, `tmux`.
 * Those are the harness binaries and the harness utility — the things a run must
 * never touch on a person's machine. A file that needs one stubs it; a file that
 * forgot gets ENOENT, which is the whole point.
 */
export const REACHABLE_BINARIES = [
  'ast-grep', 'env', 'git', 'node', 'npm', 'pgrep', 'ps', 'sh', 'sleep', 'tar',
];

/** Set once the seal is built, so a nested apply keeps the directory instead of rebuilding it. */
const SEAL_VAR = 'PROMPTOBUS_TEST_PATH_SEAL';

function firstOnPath(name, pathValue) {
  for (const dir of String(pathValue ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir.replace(/^"|"$/g, ''), name);
    try {
      if (existsSync(file) && (statSync(file).mode & 0o111)) return file;
    } catch {
      // Vanished between the two calls, or unreadable — the next directory answers.
    }
  }
  return null;
}

/**
 * Build the sealed PATH in `dir` and put it in `env`. Returns the directory.
 *
 * Symlinks, not copies: a copy of `npm` would lose the installation it resolves
 * relative to its own realpath, and a copy of anything is a second version of it on
 * disk. A name that is not on the machine at all is simply not linked — the seal is
 * not a dependency check, and the gate that wants `ast-grep` refuses on its own with
 * its own install line.
 *
 * POSIX only. On Windows resolution walks PATH × PATHEXT and a symlink needs a
 * privilege the run may not have; there is nowhere to run the suite there today
 * ([sandbox.mjs](sandbox.mjs) says the same about the stub launcher), and a half seal
 * that reads as a whole one is worse than none.
 */
export function sealPath(env, dir) {
  if (process.platform === 'win32') return null;
  mkdirSync(dir, { recursive: true });
  for (const name of REACHABLE_BINARIES) {
    const found = firstOnPath(name, env.PATH ?? process.env.PATH);
    if (!found) continue;
    try {
      symlinkSync(found, path.join(dir, name));
    } catch {
      // Already linked by a neighbour of the same run — the link is what matters,
      // not who made it.
    }
  }
  env.PATH = dir;
  env[SEAL_VAR] = dir;
  return dir;
}

/**
 * SESSION identity in the environment: the bus triple and the contact
 * point. Five names, and anyone who raises the mechanism as a child
 * process must drop them.
 *
 * Why these five and why one list: `PROMPTOBUS_HOME` beats a home
 * search from cwd (`resolveIdentity`) and sends the run into the LIVE
 * bus journal of the workspace; `PROMPTOBUS_ROLE` and
 * `PROMPTOBUS_TASK` give the commands a foreign identity;
 * `CLAUDE_CODE_MESSAGING_SOCKET` and `_TOKEN` are the contact point
 * of a person's live session, and handed into a foreign store they
 * call knocking on it.
 *
 * Three names are not on the list, each for its own reason. Home
 * (`HOME`) and `CLAUDE_CONFIG_DIR` a live run needs real: it calls
 * a real `claude`, and that needs its home. **`CLAUDE_CODE_SESSION_ID`
 * is not dropped either** (review note): this is the identity of the
 * session itself, not a foreign one — the script declares its own on
 * top of it, and it is also material for the address-ownership gate
 * (`foreignSession`), so dropping it would make the run blind to what
 * it checks.
 */
export const SESSION_LEAK_VARS = [...MESSAGING_VARS, ...IDENTITY_VARS];

/** Drop these five from a set of variables. `env` is edited in place and returned. */
export function dropSessionLeaks(env) {
  for (const name of SESSION_LEAK_VARS) delete env[name];
  return env;
}

// Apply the list to a set of variables. `env` is edited in place and
// returned — for the runner this is a `process.env` copy for the
// child, for the helper `process.env` itself. Home is a separate
// argument: its path is different for each (the run directory for
// the runner, a sandbox for the helper); what is shared is the list
// of names.
export function applyHygiene(env, { home, seal } = {}) {
  env[WARDEN_SWITCH] = WARDEN_OFF;
  dropSessionLeaks(env);
  for (const name of Object.keys(env)) {
    if (name.startsWith(CONTEXT_STORE_PREFIX) || name.startsWith(E2E_PREFIX)) delete env[name];
  }
  if (home) {
    for (const name of HOME_VARS) env[name] = home;
    env[CONFIG_DIR_VAR] = path.join(home, '.claude');
  } else {
    delete env[CONFIG_DIR_VAR];
  }
  // The seal directory is the caller's to place, for the same reason home is: the
  // runner puts it in the run directory it removes, and a file run by hand puts it
  // in the sandbox it was given. A caller that names neither and is already sealed
  // (a file under the runner) keeps the PATH it was handed — `sealPath` returns the
  // standing directory rather than building a second one.
  //
  // Two branches, and which one runs is decided HERE rather than inside `sealPath`:
  // that function has one behaviour — build the named directory and rewrite PATH to
  // it — and no opinion about a seal that already exists.
  //
  // A caller that NAMES a directory always gets a fresh seal in it. A nested runner
  // needs that: [runner.test.mjs](runner.test.mjs) runs a copy of the runner in a
  // sandbox, the copy has its own run directory, and inheriting the outer seal would
  // put every binary it resolves outside its own run — which is exactly what its
  // escape gate calls a hole.
  //
  // A caller that names NEITHER a seal nor a home keeps the standing one, if the
  // environment carries a live one. That is a suite file run by hand UNDER the
  // runner: its PATH is sealed already, and a second seal would be pure cost.
  const sealDir = seal ?? (home ? path.join(home, 'path-seal') : null);
  if (sealDir) sealPath(env, sealDir);
  else if (env[SEAL_VAR] && existsSync(env[SEAL_VAR])) env.PATH = env[SEAL_VAR];
  return env;
}
