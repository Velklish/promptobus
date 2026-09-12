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

### `worktreeTouchedMs` — how long ago the participant last WROTE anything in its own working tree, in

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
`config.toml`, because there is no personal set left to merge with. Hooks under
`app-server` do not run (`trustStatus: untrusted`, no bypass flag). The end-of-turn
channel is `turn/completed` only. `exec --json` is a smoke check.

Same boundary as the neighbours: the rest of the mechanism does not import this
file — it takes the driver from the registry map.

A registry-home refusal propagates from `readSession` through activation, inspect and
stop. The `gone` outcome therefore means a named registry was read and contained no
record; it is never an alias for missing configuration.

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

### `bindParticipantHomeRemoval` — remove every home under the root that no session record names

Source: `lib/driver-codex.js`, `bindParticipantHomeRemoval`.

Remove every home under the root that no session record names.

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

--- the participant's isolated Codex home -----------------------------------------

One `CODEX_HOME` per participant, built before the lift and removed with the session.
It is what makes a Codex participant's environment the mechanism's rather than the
owner's: an empty home lifts no personal MCP server, and the `[projects]` records and
the marketplace snapshot a run writes land in it instead of in `~/.codex` (measured on
codex-cli 0.146.0 by the consumer, with no paid turn).

Three things go in, and nothing else. A copy of the owner's `auth.json` at mode 0600 —
the account is the owner's, and an isolated home holding that copy answers
`codex login status` with `Logged in using ChatGPT` without a turn. The mechanism's own
MCP entries under `[mcp_servers]`. And, for a worker, the trust record for its worktree.

One channel this does NOT isolate: `~/.agents/skills`, the workspace's canonical skill
roots, are bound to `HOME` and not to `CODEX_HOME`, so the owner's 29 of them reach the
participant anyway. The owner accepted that as the boundary — those are the skills the
participant is meant to have.

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
