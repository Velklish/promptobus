// The list of "what the suite must not touch" — one place for every
// use. Not `*.test.mjs` — the runner (run.mjs) takes only those from
// the directory, so this file is not in the run.
//
// Four readers. The runner [run.mjs](run.mjs) builds the environment
// for each file of the run; the shared helper [check.mjs](check.mjs)
// covers running one file by hand — i.e. debugging, where there is no
// runner at all; and the live scripts —
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

import path from 'node:path';

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
export function applyHygiene(env, { home } = {}) {
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
  return env;
}
