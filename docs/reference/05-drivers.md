# Drivers

One page per harness contract. A driver owns the vocabulary of its binary — options, command
words, how a lift plan becomes a launch — and nothing above it: which servers a participant
gets is the workspace's call, and how a task is journalled is the engine's.

Facts here were measured on the binaries named beside them. Where a harness publishes no
documentation for what the mechanism uses, that is said rather than implied.

## Approver: lift after a reviewer result

The task orchestrator lifts `approver:<slug>` with `promptobus review <path> --task <id> --approver`
once a `type=result` from the matching `reviewer:<slug>` is on record in the task journal.
The command does not judge that result. Consumer acceptance procedure stays in the consumer's
card; this package supplies the address, liftoff, driver role, routed tuple and working
directory.

The approver session cwd is the repository clone root; a worker service worktree is attached
through `addDirs` when the review subject is that worktree. Claude Code writes launch files
to the task store. **Cursor and Codex cannot lift an approver:** Cursor reads project
configuration only from the selected workspace's `.cursor/`; Codex reads project hooks and
`.codex/skills` from the thread cwd, and writing launch files into the shared clone root
would overwrite or delete untracked project content without restoration. The approver role
ships on Claude Code only — measured on a live lift. `review --approver --harness cursor`
and `--harness codex` refuse before start. The role needs
repository writes and shell commands for merged-tree gates, squash and archive, so its
package deny list is empty, and its settings file switches off the harness's own guard on writes
in the clone root ([§ below](#the-approver-writes-to-the-shared-clone-the-harness-guard-and-the-key-that-lifts-it)). A host may add its exact external MCP write tools through
`participantDenyTools('approver')`; the completeness gate runs before any harness branch on
the harness that can lift an approver. The bus is never denied. That classification is
independent of the reviewer, whose deny lists and read-only sandbox remain unchanged.
[ADR-013](../adr/adr-013-approver-is-a-fourth-addressed-participant.md) records the floor of 7
and the worker↔approver routing exception; [ADR-015](../adr/adr-015-approver-lift-is-a-flag-on-review.md)
records the `--approver` flag and the reviewer-result precondition. A repeat lift reuses an
alive or unknown session the way a reviewer reuses one; a pending unlaunched record or a dead
session starts a fresh approver instead of spawning a second session beside the first.

## The approver writes to the shared clone: the harness guard and the key that lifts it

Source: `lib/driver-claude.js` (`settingsFile`), `lib/approver.js` (`buildApproverPrompt`, `planApprover`).

Claude Code refuses `Write`, `Edit` and `NotebookEdit` in a background session when the target
lies in the session's main checkout, until the session moves into a worktree with `EnterWorktree`.
The rule is the harness's own: the participant settings file never carried anything that imposes
it. Read from the binary of `claude` 2.1.280: the check sits in those tools' input validation and
applies to a session of kind `bg`; it lets through a target outside the session's cwd, any target
when the cwd is itself a linked worktree, and a target inside a linked worktree. The switch is the
settings key `worktree.bgIsolation` — `"worktree"`, the default, or `"none"` — and the environment
variable `CLAUDE_BG_ISOLATION` is consulted before it. What the session is told:

> This background session hasn't isolated its changes yet. Call EnterWorktree first so edits land
> in a worktree instead of the shared checkout, then retry this edit using the worktree path (a
> path inside a linked git worktree, including one you create with `git worktree add`, is
> accepted). (To disable this guard for this repo, set `"worktree": {"bgIsolation": "none"}` in
> .claude/settings.json.)

For a worker the guard is right, and it stays. The approver is seated in the clone root on
purpose — it merges, runs `archive` and fills `result.md` there — so the guard left it the shell
alone, and a participant found that out by hitting it. `archive` passed all along, being a
command. **So the Claude driver writes `"worktree": {"bgIsolation": "none"}` into the
approver's participant settings file, and into no other role's.** Measured 2026-09-24 on
`claude` 2.1.280 in a disposable clone, each session lifted with the driver's own argv (`--bg`,
`--settings`, `--permission-mode auto`) and asked for one `Write` into the clone root:

| Where the key was | Outcome |
|---|---|
| nowhere — run twice, before and after the next row | refused, with the text above |
| the participant settings file (`--settings`) | written |
| `CLAUDE_BG_ISOLATION=none` in the environment of `claude --bg` | refused — the variable does not reach the session |
| `"none"` in the settings file, `"worktree"` in the clone's `.claude/settings.json` | written — the `--settings` layer wins |
| `"none"` in the clone's `.claude/settings.json` only | written |

The last row is the control for the one above it: the clone's own file is read, so the fourth row
is the `--settings` layer beating it, not a file nobody read. The environment row agrees with
[§ The harness binary after a lift](#the-harness-binary-after-a-lift-the-lifts-door-not-path): a
background session gets the environment of the daemon that pre-created it. The clone's own
`.claude/settings.json` would lift the guard as well, but for every background session in that
repository, workers included, and the file is the consumer's; the package does not write it.

**The same key rewrites the session's own instructions.** Read from the binary of `claude`
2.1.280, not measured live: the `# Background Session` section of the system prompt reads the same
switch. Under `"none"` its isolation paragraph becomes "Edit files directly in your working
directory — this session is configured to work in place rather than isolating into a worktree.
Skip EnterWorktree unless the user explicitly asks to work in a worktree.", and the git paragraph
after it is dropped whole: commit before finishing and push if the repository has a remote,
"Never push to main/master, force-push, or merge.", and ask before committing or switching
branches in the user's own checkout. Most of that paragraph contradicted the approver's role — it
merges and commits in that checkout — but with it the approver loses the ban on push and
force-push. So its preamble (`buildApproverPrompt`) states it: the approver never pushes, never
force-pushes and never rewrites commits already on the remote; the orchestrator pushes. "On the
remote" rather than "the main branch's history", because an acceptance procedure may squash
local, unpushed commits on purpose.

**The key reaches a fresh lift only.** A repeat `review --approver` onto a live or unknown
approver session reuses it and returns before the launch files are written (`planApprover`'s
`reuse`, checked ahead of `writeLaunchFiles`), so that session's settings file is not rewritten. A
session lifted by an earlier version keeps the guard until it is stopped and lifted again.

**Not measured.** A managed (policy) tier: the binary lists `worktree.bgIsolation` among the keys
that tier merges restrictively, with `"worktree"` as the restrictive value, so an organisation
that sets it there presumably keeps the guard on for the approver too, and the approver is back to
the shell. `"worktree"` in `~/.claude/settings.json`: the `--settings` layer sits above user
settings by the harness's precedence, which is an assumption here rather than a run. The worker
tree attached through `addDirs` is a linked worktree, so writes there were never refused — that is
read from the binary, not measured. Cursor and Codex cannot lift an approver, so no other driver
has this key to write.

## A stop returns after the record is gone, not after the command returns

Both session drivers wait past their own stop command, and the numbers behind that come
from a live run rather than from caution. Measured 2026-09-03 on `claude` 2.1.251, three
runs in a row: `claude stop <id>` returned in 677, 801 and 898 ms, while the record left
`claude agents --json` after 1070, 1145 and 1218 ms from the start of the call — so the
command returns 270–390 ms **before** the session is gone from the registry. The ceiling
of 10 s is an eightfold margin on the worst of those; it is not the cost of a normal stop
but the point past which the wait ends and says so out loud. The poll step is shorter than
one probe, since each probe is a `claude agents --json` run measured at 0.34–0.41 s, and a
shorter step would add processes without adding information; at the ceiling that is about
twenty probes, and only on a hung stop. The list is taken fresh on every probe, because a
parsed reply is remembered until the cache reset and the loop would otherwise read one
snapshot until the ceiling.

Why the wait exists at all: directory cleanup follows the stop, asks for session state, and
on a still-live record lawfully keeps the worktree with "will be removed on the next
promptobus done". The live run of 2026-09-03 00:14 went red on exactly that — four verdicts
on steps 13–14 beside a green stop. The outcome is a **tristate**, not a boolean: `gone` —
no record; `timeout` — the ceiling ran out with the record still there; `unreadable` — the
registry could not be read. Saying "session closed" on an unreadable registry would assert
the unchecked, which is what the "unknown is not death" rule exists to prevent. The caller
maps `timeout` and `unreadable` onto one unconfirmed outcome, but their reasons differ and
they tell a person different things.

The Cursor side waits for the same reason: the harness command takes the pane down long
before the processes the turn started are gone, so the operation returns only once the
harness no longer has the session. That timing, and the reap it earned, are measured in
[03-cli § Status, done, sweep, dismiss, history, prune](03-cli.md#status-done-sweep-dismiss-history-prune).

**The Remote Control entry on claude.ai and the desktop app.** A session lifted by Claude Code
with `--bg` registers a Remote Control session under the user's account by default (`bridgeSessionId`
in `~/.claude/jobs/<id>/state.json`), measured 2026-09-24 on `claude` 2.1.280 and 2026-09-25. Process
teardown at exit is what removes it (read from the binary's strings, not documented behavior); on a killed or
abruptly stopped process that teardown may never complete, leaving an entry listed as "Remote Control ·
offline" indefinitely (the cause of the residual entry remains a hypothesis). A participant is driven over
the bus and never needs Remote Control, so its participant settings file carries `"disableRemoteControl": true`
([03-cli § Spawn](03-cli.md#spawn)) and never registers one. Entries left behind by sessions lifted without
this key — earlier lifts and the orchestrator's own session — are not archived by the bus; they are archived
by hand from the session menu on claude.ai or in the desktop app.

## The harness binary after a lift: the lift's door, not PATH

Source: `lib/harness-home.js` (`bindHarnessBins`, `harnessBin`), `lib/liftoff.js` (`runClaude`,
`readBgSessions`).

A lift finds its binary through the host: `host.resolveToolBin(driver.options.tool)`, which a
workspace host answers by searching `PATH` and then the tool's install directories. Everything the
Claude driver runs AFTER the lift — the state query `claude agents --json` behind `inspect`, and
`claude stop` — used to call the bare name through the `PATH` of whatever process asked. From a
lifted participant that is the wrong `PATH`: a background Claude session inherits the environment of
the daemon that pre-created it, not the one `spawn` passed (measured on `claude` 2.1.251, 2026-09-03,
the note beside `sessionEnv` in `lib/spawn.js`), and that daemon's `PATH` need not hold the install
directory. Measured 2026-09-24 in a lifted worker session on `claude` 2.1.280: `command -v claude` →
exit 1, while the binary was `~/.local/bin/claude`. An approver running `sweep` there got "session is
unknown", and `stop` said "no live session — nothing to stop" with exit 0.

**So the calls after a lift take the lift's door.** `runClaude` asks `harnessBin('claude')`, which
asks the host bound for the process — `hostOf` and `runPromptobus` bind it next to the registry home,
and the first binding wins for the reason [02-host](02-host.md#the-harness-session-registry-and-the-refusal-when-nobody-says)
gives. Giving the lifted session a `PATH` instead is not in the lift's power for this harness, for the
reason above. No host bound means the bare name and `PATH`, as before; the standalone host hands the
bare name back by design, so under it nothing changes.

**The version gate stays the lift's.** A host may refuse a binary it found for being too old
(`ok: false` beside a `bin`); the state query and the stop take that `bin` anyway, because reading
and stopping a session the lift already made needs the binary, not a fresh verdict on it. The
workspace host's `resolveToolBin` runs `--version`; measured 2026-09-24 on `claude` 2.1.280, that
answers in 0.01–0.02 s against 0.37–0.43 s for one `claude agents --json`, and the host remembers it
for the process.

**Two failures, told apart.** Neither is a fact about the session:

- **The binary was not found, or does not start** — the host names none, the one it names does not
  exist (`ENOENT`), or the system refuses to start it (`EACCES`, `ENOEXEC`). `inspect` refuses with a
  `GateError` whose words name it: the host's own reason, `looked for claude on this process's PATH`,
  or `the harness binary does not start: <path> (<code>)`. The snapshot degrades that refusal to
  `unknown` for THIS participant with the reason attached, as it does for a registry home nobody
  named, so the other participants keep their state and `status` prints the reason on the line.
- **The registry could not be read** — the binary ran and `claude agents --json` failed or did not
  parse. `inspect` answers `null`, and the whole snapshot is `null`, as before.

`stop` on either is `ok: false` — an unread registry says nothing about whether the session still
runs, so it is not "nothing to stop". `sweep` and `stop` name which of the two happened
([03-cli § Status, done, sweep, dismiss, history, prune](03-cli.md#status-done-sweep-dismiss-history-prune)).
One side effect in the warden: with the binary missing, a Claude participant's stall mark is not
carried through that round, because its state is unknown rather than the whole snapshot being absent
— the behaviour a Cursor or Codex participant already has when its registry home is not named.

The other drivers: Codex's `inspect` and `stop` read its registry files and signal pids, and run no
binary. Cursor's `stop` re-resolves the recorded agent path through `PATH` and its install
directories (`liveBin`), and its `tmux` calls search the same places and run tmux by absolute
path ([Cursor: tmux by absolute path](#cursor-tmux-by-absolute-path)).

## Cursor: the persist session

Source: `lib/cursor-persist.js`.

Persist-session machinery of Cursor — the inside of the Cursor driver
([driver-cursor.js](../../lib/driver-cursor.js)), one floor below it, as [liftoff.js](../../lib/liftoff.js)
is for Claude. Nobody outside imports this file: the adapter-boundary gate
([promptobus-adapter.test.mjs](../../test/promptobus-adapter.test.mjs)) holds it too.

**What `agent persist` is.** A wrapper over tmux (spike, REPORT §2): the subcommand
lifts an ordinary interactive TUI in a pane of the `cursor-agent` tmux server
(`TMUX_TMPDIR=/tmp tmux -u -L cursor-agent -f /dev/null`), stamps the session with its
options (`@cursor_managed`, `@cursor_workspace_hash`, `@cursor_session_version`,
`@cursor_chat_id`), and outlives the parent. It has no socket of its own and no
session server of its own — everything the mechanism needs from a “session server”
is given by tmux: list, input, output, stop.

**The mechanism's own marks, and a lift that refuses when one does not take.**
After the session is seen, and before the launch pane is stopped, `liftSession` sets
`@promptobus_task` and `@promptobus_address`. Each `set-option` is checked by its exit
code and then read back with `show-options -v`. The call is tried twice. A mark that
still does not match refuses the lift: `ok: false`, and the error names the option
(`@promptobus_task did not take on persist session <name>: … — the persist session was
stopped`). The driver prints that inside `persist session did not lift (…)`, so the
spawn line is where the miss shows, and the persist session is killed rather than left
unmarked on the shared server. A session list taken after a successful lift is a
different reading: the lift does not return until the read-back matches, so a list that
lacks the mark was not how the miss was detected.

Measured on tmux 3.6b, 2026-09-25, on a private server: `set-option` against a target
that is not a session exits 1 `no such session`; an unset user option under
`show-options -v` exits 1 `invalid option: @promptobus_task`; a set that applies exits 0
and the next read is the value. Exit 0 is not the whole check. The suite stand keeps a
session as one JSON file, and a writer that reads it, changes one field and writes the
object back drops an option a concurrent `set-option` has already stored — that call has
exited 0. The read-back is what sees the drop. The stand holds a per-session lock across
that rewrite; a live tmux server applies one `set-option` at a time and has no such rewrite.

**Hence three things the headless path did not have.** A live process between turns,
human entry (`agent persist attach`), and programmatic input into a live session: text
arrives by keypress in the TUI, not by a new process. The mechanism no longer holds
turns at all — the binary itself holds them, and the mechanism keeps the session
record and talks to it through tmux.

**Registry home is `~/.promptobus/cursor`, not `~/.cursor`.** The second is the
human's home, and the mechanism has no right to write there beyond what Cursor itself
lays. `PROMPTOBUS_CURSOR_HOME` moves it entirely: the suite uses it to put the
registry in a sandbox, otherwise a run would write into the developer's home. Cursor's
own home is moved by its own variable — `PROMPTOBUS_CURSOR_USER_HOME` — and only the
suite moves that too: real transcripts live in `~/.cursor/projects`.
A missing registry-home declaration propagates through direct `inspect`, `stop` and
`activate` calls; the aggregate session snapshot degrades driver errors to `unknown`,
and `registerWake` keeps its safety catch. `null` means the named registry was opened
and held no readable record.

Every number and shape below was taken from live spike runs (2026-09-03, `agent`
2026.09.02-c22c1a3, tmux 3.6b), not inferred from documentation: Cursor has no docs
on `persist` at all, and the subcommand itself has no flags of its own.

**Nothing is refused on the requested effort, and that is a measurement rather than a gap.**
In Cursor the effort level is a flat suffix on the model id, not a separate flag, so only the
binary knows whether a given model-and-level pair exists: not every model has every level, and
one level appears on a single family. Asking it costs almost nothing and refusing on a guess
would cost a lift — a bad id comes back in about two seconds with empty stdout and a list of
the ids that do exist, without opening a chat. So `optionRefusal` refuses on the binary version
and on `tmux`, and leaves the model-and-level pair to the binary.

### Cursor: tmux by absolute path

Source: `lib/cursor-persist.js` (`tmuxBin`, `tmux`, `readTmuxSessions`, `findSession`).

Every tmux call — the state query behind `inspect`, `activate`, `stop`, the lift's panes — runs
the binary `tmuxBin` finds: `PATH`, then the install directories the Cursor binary is looked for
in (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`). That is the search the lift's check
makes, and the check (`resolveTmux` behind `optionRefusal`) now calls the same function, so a lift
never passes on a tmux that calls from the same environment cannot find. The warden, `stop`,
`sweep` and `status` run in other processes with their own `PATH` and `HOME`; such a caller may
still miss it, and then reads `unknown`, not `stale`. The calls used the bare name, so a tmux only
an install directory held was found by the lift's check and missed by every call. The
environment goes to tmux unchanged: a `PATH` widened to find it would become the server's
environment on its first `new-session` and reach every pane started after that.

**Two failures, told apart.** A tmux that could not be run — found in neither list, or refused
by the system at start — is not an empty server. `readTmuxSessions` returns the reason as
`missing`, and `findSession` refuses with a `GateError` naming tmux and the session instead of
answering `null`. `inspect` passes that refusal on, so the snapshot reads the participant
`unknown` with the reason on its `status` line; `stop` and `sweep` refuse with exit 1 on that
line; and the driver's own `stop` is `ok: false` and touches neither the record nor the
session's processes. Before, the unread server read as empty, `inspect` answered `stale`, and
`liveParticipant` reads `stale` as dead: `stop` said "no live session — nothing to stop" with
exit 0, and a direct call of the driver's `stop` dropped the record of a session that was still
running. A server that answers "no server running" still reads as no sessions — a tmux server
lives while it has sessions — so `stale` keeps its meaning: stopped from outside, or the machine
rebooted.

**Only a measured no-server line reads that way.** `readTmuxSessions` matches a non-zero exit
against the two wordings measured on tmux 3.6b — "no server running on …" and "error connecting
to … (No such file or directory)" — by stable substring, not by the socket path they carry. Any
other non-zero exit takes the tmux-could-not-be-run refusal instead, naming tmux's own exit code
and stderr line (`tmux list-sessions exited <n>: <line>`), through the same readers: a live
participant is never read as gone on a server that answered something else.

`PROMPTOBUS_CURSOR_INSTALL_DIRS` replaces the install-directory list, delimiter-separated, for
the Cursor binary search and for tmux alike, read from the environment the search is handed. It
is a suite seam and is unset in life: the absolute entries sit outside any sandboxed `HOME`, so
the suite's hygiene (`test/hygiene.mjs`) sets it to `~/.local/bin` — the sandbox one — and an
unstubbed tmux there is not found rather than the machine's. The Cursor-binary search shares the
same seam, so `test/promptobus-driver-cursor.test.mjs` hands its own `findCursorBin`/`liveBin`
checks the same sealed value rather than letting them fall through to the default list.

### The driver contract

Source: `src/driver.ts`.

Driver contract and driver registry, entry point "./driver".

Driver — adapter of one harness: it launches a participant session, recognises its
state, wakes it, and can stop it. Which harness it is — the package does not know
and has no right to know: only the contract is declared here, and the drivers
themselves live at the consumer. The registry is passed into core EXPLICITLY, as a
`harness → driver` map, and an unknown harness refuses BEFORE anything changes in
the store: a refusal after writing the participant would leave in the task journal
a participant with nothing to wake it by.

Constraint invisible from this file: no harness name is here and none can be —
the package set gate watches for that.

`normalizeTool?(tool, context)` is an optional pre-launch hook. Core calls it after
`resolveToolBin` and before refusal, launch and provenance recording; a driver may use it to
pin a mutable updater path and probe the version of that same concrete binary. If it is absent,
the host's `HostToolBin` passes through unchanged. It is not a capability and is not required
of drivers whose binaries do not need this normalization.

`refuseForeignProjectHooks?(lookupDir, writtenDir)` is optional. Spawn calls it at plan
time, before the first write of this lift, when the driver has the operation. It throws
GateError naming the file, and returns nothing when there is nothing to refuse. A string
return is not a refusal: spawn does not read one. The Codex driver throws when Codex would
load a hooks file from a path this lift does not write. A harness with no such file leaves
the operation absent, and spawn does not ask it.

### `worktreeTouchedMs` — the third liveness signal, and what the first two miss

Source: `lib/cursor-persist.js`, `worktreeTouchedMs`.

How long ago the participant last WROTE anything in its own working tree, in
milliseconds. The third liveness signal, and the one the first two are blind to.

The transcript grows when the TUI finishes a call. The pane's process tree grows when
a tool is a separate process. Editing a file is neither: the agent writes it itself,
inside one long call, and spawns nothing. A live Cursor participant was reported
stalled twice on 2026-09-04 and 2026-09-05 while it was doing exactly that — the owner
opened the panel and saw sixteen files edited, and the participant named a commit from
the same window (PB-7).

Two questions to git, both about the participant's own directory: the newest mtime
among the files git calls changed or untracked, and the commit time of HEAD. The first
is git's own walk, so `node_modules` and every other ignored path cost nothing; the
second covers the worker that commits as it goes and leaves a clean tree behind.

The signal is POSITIVE ONLY, and that is the whole of its contract. A recent write
proves the turn is alive. No write proves nothing — a turn can read for minutes — so
it may lift a stall verdict and may never raise one. It is also why a genuinely dead
session still stalls: nothing writes on its behalf, and the age only grows.

`null` — the record names no working directory, the directory is gone, or git refused
both questions. The caller reports that rather than reading it as either answer.

### `injectText` — deliver text into a live session

Source: `lib/cursor-persist.js`, `injectText`.

Deliver text into a live session.

The protocol is the one the spike measured (REPORT §4.3), and each step pays for a
live miss:

  1. **the input field is cleared**, otherwise leftover from a previous failure
     rides out with the new text;
  2. **text rides in a tmux buffer**, not `send-keys -l`: a multiline message via
     bracketed paste lands in the transcript as ONE message, and line-by-line input
     would send it as several;
  3. **a pause stands between paste and `Enter`** — without it Enter is lost, the
     text stays in the field and glues onto the next message;
  4. **paste and send are checked against `capture-pane`**: empty in the field
     means it went.

Delivery also goes into a RUNNING turn. The text queues in the TUI and runs as a
separate turn right after the current one (REPORT §4.3): the running turn does not
see it, the injection does not interrupt the turn, a second parallel turn does not
appear. There is no longer a reason to refuse “a turn is running” here — the
message is not lost, it waits.

### Launch directories a driver claims

Source: `src/driver.ts`.

Directories inside the participant's working directory that this driver's launch
files claim.

Before the first write the caller asks Git what the lift is about to overwrite, and
it asks about **the paths the lift writes** — never about the claimed directory as a
whole. A declared directory is not a claim on everything under it: a repository may
lawfully keep files of its own there, and a lift that does not write them must not
announce them. What this field supplies is the boundary — where a launch file's
absolute path stops being the working directory and becomes the pathspec Git is
asked about.

A launch file that copies a whole directory is the one that matters most: its
destination is erased before the copy, so everything tracked under that one path is
lost rather than merely rewritten. It needs no separate declaration — the
destination is itself a written path, and a directory in a pathspec covers its
subtree.

Optional: a driver whose launch files land outside the repository claims none and is
asked nothing.

### `CODEX` — codex harness driver — the third production bus driver

Source: `lib/driver-codex.js`, `CODEX`.

Codex harness driver — the third production bus driver.
Everything the mechanism knows about Codex lives here: option vocabulary, command
words, turning a plan into `thread/start` params, and approval replies. The thread
registry and the process holder are in [codex-session.js](../../lib/codex-session.js).

**What Codex does differently.** A session is a thread in its own
`codex app-server --stdio` process, and that process runs in a `CODEX_HOME` of its
own — one per participant, built at lift and removed at `done`. cwd, sandbox and
instructions go as `thread/start` params; the MCP set goes into that home's
`config.toml`, because there is no personal set left to merge with. Hook trust for an
app-server thread is the `thread/start` override `bypass_hook_trust`, not the CLI flag:
that flag is parsed and then dropped by the app-server subcommand. The feature `hooks`
is stable and on by default, and a handler is enabled unless its state says otherwise.
A linked worktree reads project `hooks.json` from the main checkout, so a worker's
copy is written to the participant home after that home is built, and not among the
launch files. A reviewer sandbox is not a worktree and keeps the single file in its
working directory. An approver on Codex is not covered. The measured event is
SessionStart; Stop was not in those journals. `bypass_hook_trust` trusts every
project hooks file Codex discovers. A file at a path this lift writes is its own
and is rewritten, whatever its bytes; the reviewer sandbox is that path. Any file
in the main checkout refuses, including one with the same bytes, because that
path is not one this lift writes and Codex would load it beside the home copy.
The refusal is before the worktree exists, so a dry run refuses too. An ancestor
`.codex` is disabled unless that folder, the project root, or the repo root is
trusted. The home trusts only the working directory, so those layers are not
loaded, and the bypass does not enable them. Remove or move the file, or lift
the participant on another harness. The end-of-turn channel is
`turn/completed` only. `exec --json` is a smoke check.

The worker preamble names its absolute worktree path and the session roots (`cwd` and
`addDirs`) before the assignment. Holder approvals still use those recorded roots.
An outside refusal logs the resolved allowed roots and prints a requested-to-resolved
pair only when the target changed during resolution; the reply to Codex remains
`{ decision: 'decline' }`.

**The participant shell and the holder approval are separate boundaries.** Two independent
Codex participants on codex-cli 0.146.0 had no successful apply_patch call, and direct
un-escalated shell writes to each worktree were refused. $TMPDIR and /tmp accepted temporary
writes; listen on 127.0.0.1 was refused separately. The ordinary git commit --allow-empty probe
also returned rc=128 at index.lock. Successful worktree and Git metadata writes used the escalated
exec_command route, including an independent generated git apply that exited 0 and the reversible
empty-commit/reset probe, which returned rc=0 for both operations. The result is measured for those
participants and version, not universal (PB-191, PB-194).

**On codex-cli 0.156.1 the plain shell writes the worktree.** Measured 2026-09-25 on one worker
lifted by this mechanism with `workspace-write`, in one paid turn, with no escalation: `test -w .`
returned 0, `touch` in the worktree root returned 0, `mkdir` under `$TMPDIR` returned 0, and
`git commit --allow-empty` returned 0 and made the commit. `listen` on 127.0.0.1 was still refused
with `EPERM`. An `apply_patch` inside the worktree was applied with no approval request at all. An
`apply_patch` into the worktree's parent raised `item/fileChange/requestApproval`, still with no
path, and the holder refused it as `carries no path to contain`; the file was not written. The
escalated route was not exercised, because no write failed. The 0.146.0 boundary above did not
recur on this binary; the new one is claimed for this one participant and no further.

A real lift prints a provenance line with the resolved CLI entry path, the executing Promptobus
package path and version from `import.meta.url`, the host version, the participant binary path, and
its version when known. The Codex session record keeps the same line as its first JSON field, and
the holder log starts with it; Cursor's persistent session record does too. The protocol's
existing `mechanismVersion` field remains the host writer version for mixed-version readers;
provenance uses separate package and host fields. An unresolved CLI path names its reason, so a
live measurement without an attributable header is not attributable. A header REBUILT from a
record that carries no package field reports `package=unresolved (…)`: the reconstruction never
substitutes the reading copy's own path, because a record written elsewhere would then be signed
by whoever read it. The package path is the only discriminator between a tree copy and an
installed one at the same version, so a check run from the tree does not demonstrate that the
field follows the executing copy — a second copy at another path has to name itself. These
fields identify the executing location and reported release, not exact code identity:
different revisions at the same path and version remain indistinguishable.

Same boundary as the neighbours: the rest of the mechanism does not import this
file — it takes the driver from the registry map.

A registry-home refusal propagates from `readSession` through activation, inspect and
stop. The `gone` outcome therefore means a named registry was read and contained no
record; it is never an alias for missing configuration.

#### The two `mcp_servers` transports, and the field that kills the config load

The workspace MCP set is written into the `[mcp_servers]` tables of the participant home's
`config.toml`, and Codex has **two transports whose fields do not overlap**:
`streamable_http` knows `url`, `http_headers` and `bearer_token_env_var`; `stdio` knows
`command`, `args`, `env` and `cwd`. A foreign field is not ignored — it kills the config
load entirely and the participant does not lift at all, with the reply *"failed to load
configuration: args is not supported for streamable_http in `mcp_servers.<name>`"*.
Measured on codex-cli 0.146.0 with `thread/start` into an isolated `CODEX_HOME`: `{args,
env}` on top of a url-server produced exactly that refusal, `{url, http_headers}` lifted the
thread. An unknown transport — Claude Code's `sse` has no Codex counterpart — is not emitted
at all, because a record with neither `url` nor `command` is an unbuildable half.

The isolated home removed the NAME collision the key prefix was first introduced against:
there is no personal set left to merge with, so the entries have one source and one shape.
The prefix stays for the other thing it does, which the home does not replace — the tool
name the participant is told is derived from the config key (§ Consumer identity inside a
harness in [02-host](02-host.md)).

`ThreadStartParams.config` remains the passthrough for the one key that is per-turn rather
than per-home: `model_reasoning_effort`, which both roles honour. Measured on codex-cli
0.146.0 with no paid turn — the thread echoes the asked level back as
`ThreadStartResponse.reasoningEffort`; the first `turn/start` sends effort as well, and that
value persists across later wakes on the same thread. Both roles use `turn/start` so the bus
tools stay on the participant thread: `review/start` was an observed stall of the bus mailbox
and is unused.

#### The holder's record watch

The holder outlives the command that started it — that is the point of it — but it must not
outlive its own SESSION, and nothing else can reap it: `stop` and the suite stands both reap
from a cleanup hook, and the take-down that leaks is the one no hook reaches. The suite
runner takes a file down with `SIGKILL` at a file timeout and on Ctrl-C; a run on 2026-09-04
left twelve holder processes alive into the next day, each holding a session file in a
directory that no longer existed.

The record IS the session: `dropSession` removes it on stop, and so does whoever removes the
tree it lives in, so gone means there is nothing left to hold. The watch tests with
`existsSync` rather than a read — the record is replaced by rename and is never transiently
absent, while an unreadable file is a reason to keep holding rather than to die. The
app-server is killed FIRST and the exit is immediate, because the child's own exit handler
writes to the holder log and that write would recreate the tree that was just removed. The
interval is `unref`ed, so the watch is never the reason the process is alive.

The holder log follows the same rule from the other side: it does NOT create its directory.
The sessions directory is written before the holder starts, and by the time it is missing the
run that owned it is gone — recreating it would resurrect the tree the holder is about to die
with. The window is real: the app-server's stderr and the protocol notifications both log,
and either can arrive inside the five seconds between the tree going and the record watch
firing. A write with nowhere to go is dropped, because this is diagnostics and the holder
must not fall over its own log.

### `reviewSandbox` — reviewer working directory: the mechanism's own, not the tree under review

Source: `lib/driver-codex.js`, `reviewSandbox`.

Reviewer working directory: the mechanism's own, not the tree under review.

A Codex reviewer used to sit in the reviewed clone, and two things followed. It got no
workspace skills — the review procedure arrives as a module skill, and copying a canon
into a foreign tree would dirty the branch a worker is still committing to. And it got
no project trust — trusting the reviewed tree would let the repository being judged put
MCP servers into the session judging it ([ADR-008](../adr/adr-008-codex-reviewer-working-directory.md)).
Seated in a directory of its own, the reviewer gets both, and the reviewed tree gains
no file from the lift: it is attached as a read through `addDirs`, the way the rule
files already are.

The directory is DETERMINISTIC, not `mkdtemp`, for the same reason the Cursor sandbox
and the participant home are: `prepare` writes and launches nothing, and `--dry-run`
must print the path a real lift will use. It sits beside the other participant files in
the task store, so `done` sweeps it with them — by the address stem, without asking a
driver.

### `sweepParticipantHomes` — remove every home of this registry that no session record names

Source: `lib/driver-codex.js`, `sweepParticipantHomes`.

Remove every home of this registry that no session record names.

The homes root is one directory, `$TMPDIR/promptobus-codex-homes`. A home is a direct child of it.
`removeParticipantHome` still refuses anything that is not: the owner's `~/.codex`, a nested path,
the root itself. The directory name ends with `_` and the sha1 of `path.resolve` of
`harnessStateHome('codex', env)` — the environment variable first, otherwise the bound host's
answer. `participantCodexHome`, `makeParticipantHome`, `sweepParticipantHomes` and
`sweepParticipant` all take that suffix from one function. The readable head and the task-address
hash are unchanged. `--dry-run` and a real lift both call `participantCodexHome`, so the printed
path is the path that will be built. A sweep deletes a child only when that suffix is its own and
no session record names the path. `makeParticipantHome` refuses a directory that does not carry it.
The plan's home is named from the environment the lift will pass — the process environment
overlaid with the host's extra environment.

A second registry has a different suffix in the same directory. A lift under it reads that root and
leaves the first registry's names in place, because the suffix is not its own. The same task and
address under two registries are two directories. The key is `path.resolve` of the registry home,
not its realpath: two spellings that do not fold are two registries, and neither sweep removes the
other's homes.

A home an older version left is a direct child of that same root with no `_` in the name: the older
slug replaces every non-alphanumeric with `-`, so it cannot carry this suffix. A sweep cannot prove
which registry made it, and does not remove it. The directory stays, credentials copy included, until
an operator deletes it. Nothing in this version moves it or deletes it from the sweep. A session
record that already stores that exact path still removes it when the record is dropped — the record
is the proof, and the guard allows any direct child.

When `harnessStateHome` refuses — no environment variable and no bound host — the sweep returns
nothing and removes nothing. The lift already refuses on that same answer. Reading every child as
an orphan would empty the root.

A home holds a copy of the owner's credentials and the `http_headers` of the
canonical MCP set in the clear, and the paths that remove one all need something to
hold: `stop` needs a record, `done` needs a participant whose session is still
alive. Three ways to lose that hold are real — a holder killed outright, a lift that
died between building the home and writing the record, and a task closed while its
app-server was already dead — and in each the home is the only thing left. So the
lift and the stop of ANY Codex participant also collect what earlier ones left: a
home whose record is gone is a home whose session is over.

Deliberately not keyed on age. A home is legitimate exactly while a record names it,
and a grace period would only be a window for a secret to sit in.

`dropSession` removes the home with the record it belongs to, and it asks this
function to do it: the guard above is the only place that decides what may be
removed, and the registry must not grow a second opinion.

### Codex: the phrases a participant is addressed by

Source: `lib/driver-codex.js`.

The participant's isolated Codex home.

One `CODEX_HOME` per participant, a direct child of `$TMPDIR/promptobus-codex-homes` whose name
ends with the registry suffix under `sweepParticipantHomes`, built before the lift and removed
with the session. The same task and address under two registries are two directories.
It is what makes a Codex participant's environment the mechanism's rather than the
owner's: an empty home lifts no personal MCP server, and the `[projects]` records and
the marketplace snapshot a run writes land in it instead of in `~/.codex` (measured on
codex-cli 0.146.0 by the consumer, with no paid turn).

Four things go in, and nothing else. A copy of the owner's `auth.json` at mode 0600 —
the account is the owner's, and an isolated home holding that copy answers
`codex login status` with `Logged in using ChatGPT` without a turn. The mechanism's own
MCP entries under `[mcp_servers]`. The trust record for the participant's own working
directory. And `[features] apps = false`, for every role.

One channel this does NOT isolate: `~/.agents/skills`, the workspace's canonical skill
roots, are bound to `HOME` and not to `CODEX_HOME`, so the owner's 29 of them reach the
participant anyway. The owner accepted that as the boundary — those are the skills the
participant is meant to have.

#### The built-in `codex_apps` server stays off in the participant home

codex-cli 0.156.1 runs an MCP server of its own in any home whose `apps` feature is on, and
`codex features list` prints that feature as `stable` and `true` by default. Measured
2026-09-25 with no turn: a home built the way the lift builds it — a copy of `auth.json`, the
trust record and one MCP entry — reported a second server in the thread-scoped
`mcpServerStatus/list`: `codex_apps`, connected, with 52 tools. Some of them act on the
owner's account: `sites.delete_site`, `sites.deploy_site_version`,
`sites.update_environment_variables`, `plugin_management.uninstall_app` and more. That made
two statements false: that the participant has no MCP server but the mechanism's, and that
the reviewer's `disabled_tools` covers every server the reviewer has. The server list is in
the [enforcement record](../../test/fixtures/codex-app-server/0.156.1/DisabledToolsEnforcement-0.156.1-2026-09-25.json).

So `codexHomeConfig` writes `[features] apps = false` into every participant home, for every
role. With the key, the same probe got `apps stable false` from `codex features list`, and the
thread listed the mechanism's server and nothing else. That server came up, so the config
loaded, and the missing `codex_apps` is the key's doing rather than a failed load. The key is a
boolean, and the home's table writer produces only strings, so it goes in as a fixed block.
Whether 0.146.0 ran the same server is not known. That binary is no longer installed, and its
records name only the probe server.

The holder accepts an `mcp_tool_call` elicitation only when its `serverName` is a
`[mcp_servers]` key of that participant's home. The elicitation carries the name as
`serverName`, required on `McpServerElicitationRequestParams` in the 0.156.1
[`ServerRequest` schema](../../test/fixtures/codex-app-server/0.156.1/ServerRequest.json).
The keys are the set the lift wrote, read once at holder start: whatever `codexMcpServers`
produced for that participant and `codexHomeConfig` wrote into `config.toml` before the
holder process began. The holder keeps that set for the life of the process and does not
read the file again. There is no second list on the session record. A workspace-write
participant can append a table under `$TMPDIR`, where the home lives, and a later read
would approve the server it had just named. A reviewer and a worker are different
participants, so each snapshot is that participant's own home at the moment its holder
started. A name the snapshot does not contain is declined — a built-in server, a server
a later feature adds, a missing `serverName`, a record that names no home, or a
`config.toml` that cannot be read at start — and the reason is written to the holder log
and the warden log with the other refusals. The match is the string as sent against the
table key as written, including a key the writer had to quote. A nested table such as
`[mcp_servers.<name>.env]` is not itself a server. Turning `apps` off still keeps
`codex_apps` out of the thread; this check is what refuses the elicitation if a server
arrives that the lift did not configure. Whether app-server reloads `config.toml` during
a session was not measured.

For `item/tool/requestUserInput`, the holder answers with the 0.156.1
`ToolRequestUserInputResponse` shape: `answers` maps each received question id to
`{ "answers": [] }`. It has no person to supply a choice or free text, so it records no
selection. A denied request gets an empty `answers` map. The reply is checked against the
[generated response schema](../../test/fixtures/codex-app-server/0.156.1/ToolRequestUserInputResponse.json);
whether app-server accepts an empty answer for every question at runtime has not been
measured.

## `sessionStall` — sessionStall answers null for no stall, otherwise { kind, reason }. kind is permission

Source: `lib/driver-claude.js`, `sessionStall`.


`sessionStall` answers `null` for no stall, otherwise `{ kind, reason }`. `kind` is `permission`
— a dialog mark stands on the record — `limit`, which clears itself, or `unknown`, for which no
route is derived.

**The reason arrives in two halves.** The session list carries one: `waitingFor` exists only on a
session standing at a dialog, and a limit has nothing there. The other half is on the
background-session daemon, in `<claude config>/jobs/<id>/state.json`, field `detail`. That format
is not a contract — unreadable means there is no reason, and inventing one is forbidden.

**The parse entry is the TURN END, not the `blocked` state.** It used to sit on
`state === 'blocked'`, and on claude 2.1.251 no session that had finished a turn ever entered it:
six `claude agents --json` snapshots 20 s apart, 2026-09-02, gave both sessions `status: idle`,
`state: done`, `waitingFor: null`, and across all nine machine records the background sessions
showed exactly two pairs — `busy/working` and `idle/done`. A silent participant was therefore
invisible and its report never left; a live E2E run caught it, the verdict going red on a healthy
stand. So `unknown` opens on `status: idle` in ANY state, and `busy`/`working` without a dialog
mark is not a stall at all — a turn is running. The dialog mark does not ask for state and sits
above that gate deliberately: a session stopped at a prompt mid-turn waits for a person whatever
it is busy with. `blocked` stays an entry beside `idle`, because records from older builds arrive
with it and dropping it would change behaviour where it already worked. The only filter on
`unknown` is the silence gate `stallStands` in the state machine, which separates a normal turn
end from a real stall.

**One field carries more than one dialog, and the record does not say which.** One is a
permission prompt of the session's own work. Another is a peer message the session HELD, because
it was lifted in a mode that bypasses prompts and the sender did not attest its own — which is
what the warden's postcard becomes there. Measured 2026-09-11 on 2.1.263: the moment the postcard
was knocked into the socket of a session lifted with `--permission-mode bypassPermissions`, its
record read `status: waiting`, `state: done`, `waitingFor: "permission prompt"`, while the session
finished its shell command, answered, and reached its Stop hook. A third is a refusal that has
already returned — the auto-mode classifier declines a call and the session carries on working;
observed 2026-09-12, where `status` called a person to a session that went on to make eight
commits and run the gates. So the classification stays `permission` and is honest about it: one
field, one answer. Which of them it was is decided a layer up, on the bus's own marks, by
`stallStands`; the lift closes the second case at the source with `crossSessionInbound` in the
participant settings file; and the route printed for a person names all three and asserts none.

## A refusal that names a reset

Source: `src/driver.ts`, `namedReset`, `resetAhead`, `resetText`; `lib/driver-codex.js`, `inspect`;
`lib/driver-claude.js`, `sessionStall`, `sessionDetailAt`.

A stall may carry `reset: { said, at }`: the harness refused a turn and named a time to retry
after. `said` is the harness's words for that time; `at` is the ISO instant they parse to, or
`null` when they do not. The warden holds its knocks on it
([03-cli § Guard and warden](03-cli.md#guard-and-warden)).

**One fact, not a taxonomy.** `namedReset` asks only whether the refusal names a time: a `limit`
word, then `try again at <time>` or `resets [at] <time>`, read to the end of that line. Any other
refusal gets no `reset` — a failure with no named time is retried as before, and "a later turn may
succeed" stays its hint.

**Two forms of time parse, and nothing else does.** A date with a year: `Date.parse` fills a
missing year with 2001, so no year means no date, and a date without a zone is read in the local
time of the machine that runs it. The Codex refusal measured on 2026-09-17 names
`Sep 19th, 2026 12:15 PM`: the ordinal suffix is dropped and it parses in local time. The holder and
the warden run on one machine; that Codex prints the time in that machine's zone is assumed, not
measured. And a 12-hour wall time in a named IANA zone, which is how Claude says it —
`resets 6:20am (Europe/Moscow)`. That one means the next such moment after the harness wrote the
line, with the zone's offset read back through `Intl.DateTimeFormat` at the reset itself, so a
daylight-saving change in between is counted. Measured on 2026-09-25 over one machine's Claude
timelines: 17 entries carrying such a line, 2026-08-25 to 2026-09-09, six distinct times, the
weekly limit among them — each resolves to a moment 1.1 minutes to 4.5 hours after its entry. A zone `Intl` does not know, a wall
time with no zone (`resets 3pm`), or no moment the line was written: `at` stays `null`. A time
that does not parse is still a named reset, only an unknown one, and every line that prints it
quotes the harness's words instead of a date.

**The moment the line was written is the harness's, not the reader's.** Taken as the moment
`inspect` reads it, a line read after its wall time would name the same time a day later, and
the hold would roll forward each heartbeat. Claude's `sessionDetailAt` reads it from the daemon's
`jobs/<id>/timeline.jsonl`: the `at` of the latest entry carrying this `detail`, from the last
64 KiB of the file. The daemon re-logs the line while the session stays blocked, and each re-log
is a new refusal naming the next such moment, so the latest one is the right anchor. The file is
not a contract either: when it is missing or holds no entry with the line, the time stays unread.

**Who attaches it.** Codex: `inspect` reads the error of a failed `lastTurn`. While that reset is
still ahead the view is a `limit` stall carrying it, and it outranks a running turn: the turn a
knock just started fails the same way, and "the turn is running" would read an unreachable
participant as a busy one. Once the named time passes, the same record is an ordinary `failed`
stall again. Claude: `sessionStall` attaches it to a `limit` stall whose detail names a time, anchored by `sessionDetailAt`. Each
driver's `limit` route then names the hold, and the relift for a run that cannot wait. `turnErrorText`
keeps the first 400 characters of the error, so a refusal whose time sits past them is read as an
ordinary failure.

**The Codex `activate` gate did not catch the measured case.** `activate` refuses a turn when the
holder's `rateLimits` snapshot says a window is reached. The refusal of 2026-09-17 came back as a
turn error instead; the snapshot of that run is not on record, so why the gate stayed open — a
window below 100 %, or a limit the snapshot does not carry — is not known.

## A lift that fails on a spent limit

Source: `lib/driver-claude.js`. The symbol is not named here: the
code edit is in another branch and this page could not read it.


A lift refused because the limit was spent marks the harness exhausted in the availability cache
and returns the line the refusal appends — empty when there was nothing to mark.

**That line exists because the mark is invisible otherwise.** A person whose participant refused
to start would be left with a file they never open, holding a state that neither time nor a later
probe lifts. So the refusal names the file and the way out of it.

**Which code is written is decided by the reset phrase, not by the limit phrase.** The limit
phrase is the gate — a limit refusal reads the same whether the session wrote it after a turn or
the binary wrote it instead of starting. When the refusal says the limit RESETS, the exhaustion
belongs to the subscription and is `subscription_exhausted`; otherwise nothing explains it and it
is `manual_exhaustion`. The reset phrase is checked even when a limit phrase also appears
elsewhere in the refusal.

**`resetAt` stays `null` on both, so both are the sticky kind.** The harness names its reset in a
person's words and a person's timezone — "resets 3pm" — and a timestamp parsed out of that would
be invented rather than measured. An exhaustion that expires at a made-up moment is worse than
one that waits for a person: it lifts itself, and nobody learns the account was out.

The entry goes through `markExhausted` with its reason stated rather than derived. That helper's
own derivation reads `resetAt` alone, and this branch has to be able to say "the subscription
named a reset this driver refuses to parse" — `subscription_exhausted` with no reset. One fact,
one door into the cache.

**A cache failure does not replace the lift's own refusal.** The person is about to be told why
their participant did not start, and a write error on the way there would take that diagnosis
with it.

## `awaitsUser` — whether a Claude transcript holds an open question

Source: `lib/driver-claude.js`, `awaitsUser`.

The warden asks this before it retries a knock on unchanged mail
([hooks-and-trust § `awaitingUser`](../guides/hooks-and-trust.md#awaitinguser--whether-the-turn-waits-on-its-user)).
The transcript is Claude Code's own JSONL, and its shape is not a
contract. The reader relies on what was measured on 2.1.280 on
2026-09-25, in three probe sessions and in a live orchestrator
transcript:

- The question is an `assistant` row whose `message.content` holds a
  `tool_use` block with `name: "AskUserQuestion"` and an `id`. It is
  written when the question opens, before `PreToolUse` fires.
- While the question is open, the only rows written after it are
  `queue-operation` rows, one per knock the session queued.
- The answer is a `user` row with a `tool_result` block whose
  `tool_use_id` names the question. A decline is the same row with
  `is_error: true`, followed by a user text row.

The reader takes the last `TRANSCRIPT_TAIL` (1 MiB) and walks it from
the end. It remembers every `tool_result` id. The newest
`AskUserQuestion` decides: open if its id has no result, closed if it
does. A `user` row that is not a tool result is a human prompt and ends
the walk as "not open". A line that does not parse is skipped. Anything
else — no question in the tail, a file that cannot be read — is "not
open". The answer is cached by the file's size and mtime, so the
warden's one-second round costs one `fstat` while nothing is written.
