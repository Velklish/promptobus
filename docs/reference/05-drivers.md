# Drivers

One page per harness contract. A driver owns the vocabulary of its binary — options, command
words, how a lift plan becomes a launch — and nothing above it: which servers a participant
gets is the workspace's call, and how a task is journalled is the engine's.

Facts here were measured on the binaries named beside them. Where a harness publishes no
documentation for what the mechanism uses, that is said rather than implied.

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

### Cursor: the third liveness signal

Source: `lib/cursor-persist.js`.

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

### Cursor: delivering text into a live session

Source: `lib/cursor-persist.js`.

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
