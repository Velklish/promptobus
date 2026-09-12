# Overview

The npm package name is `promptobus`. Version in `package.json` is `0.6.0`. License is MIT. Node.js `>=20`.

That number is written out by hand, and the suite compares it to `package.json`, the first dated release heading in `CHANGELOG.md`, and an exact `v<version>` git tag when `HEAD` has one (`test/promptobus-package.test.mjs`): it moves in the commit that cuts a release, and in no other. A reader who needs the version of the tree in front of them asks the tree — `promptobus --version` prints it without a host file.

## Entry points

| Path | What it is |
|---|---|
| `bin/promptobus.js` | CLI. Help and `--version` use a thin host. Other commands load `createStandaloneHost`. |
| `lib/cli.js` | `runPromptobus(argv, { host, … })`. Host is required. |
| `src/index.ts` → `.` | Protocol, store v1, MCP factory, driver contract, host types, standalone host |
| `src/host-index.ts` → `./host` | Host contract and the standalone implementation |
| `src/hooks.ts` → `./hooks` | Hook planner |
| `src/driver.ts` → `./driver` | Driver contract |
| `lib/cli.js` → `./cli` | Command parser |
| `schemas/v1/*.json` → `./schemas/*` | Task, participant, message, artifact schemas |

The package test installs the packed artifact and resolves each public specifier through Node's exports map, including one concrete schema, so a key-only mapping cannot pass.

The `.` entry point exports `Engine` and its public input and result types, including
`SendInput` and `SendSyncInput`; consumers do not need a deep import to name either send contract.

`src/` is TypeScript. `npm run build` emits `dist/`. `lib/*.js` is the JS runtime and the three harness drivers.

## Store home

Default store directory name: `.promptobus` (`src/v1/layout.ts` `ROOT_DIR`). The standalone host places it under the workspace root (`src/host.ts` `homeOfRoot`). `PROMPTOBUS_HOME` overrides the path for a process that already knows the home (`lib/store.js`).

Layout of one task:

```
.promptobus/tasks/<task-id>/
  task.json
  .lock/
  messages/
  intents/
    <id>.owner
  inbox/<participant-id>/
  history/<participant-id>/
  blobs/
  artifacts/
  broken/
    inbox/<participant-id>/
    artifacts/
    messages/
  files/
```

- `.lock/` is created while a read-modify-write is in progress; delete it only after the writing process is gone, following the refusal's `ps` or manual-cleanup guidance.
- `intents/<id>.owner` is written beside an open intent; remove it only with an intent that is no longer open, while recovery sweeps orphaned leases.
- `broken/inbox/<participant-id>/` is written by mailbox readers when they isolate malformed refs; it is safe to delete after retaining its diagnostic and any record needed for repair.
- `broken/artifacts/` is written by artifact readers when they isolate malformed metadata; it is safe to delete after retaining its diagnostic and any record needed for repair.
- `broken/messages/` is written by recovery for malformed intents; it is safe to delete after retaining its diagnostic and any record needed for repair.

`files/` is the folder a person opens, and it holds two kinds of file: artifacts that arrived through the bus — hard links to their blobs under the names they came with — and what the mechanism puts there itself, the `review` diff (`review-<worker>.diff`) and the `spawn` brief (`brief-<worker>.md`). A taken name is never overwritten: the next file of that stem takes the following number (`brief-<worker>-2.md`).

Sidecar files the CLI writes (warden, wake, health, worker catalogs) sit in the same task directory. The engine API does not own them.

One file sits at the **root** of the store rather than under `tasks/`: `model-routing.json`, the `workspace` overlay layer, which under the standalone host is the writable one — the file `promptobus models strategy --set` records `defaults.strategy` in, mode `0600` ([02-host](02-host.md) § The writable layer). It is state the tool writes, which is why it is here and not in the repository root, and it is per-workspace exactly as the store is. The availability cache and the participant telemetry are NOT here: they are account-scoped and live at the paths `routingPaths()` names, off the user home under standalone.

## MCP tools

Declared in `src/mcp/tools.ts` and listed in `lib/contract.js` as `PROMPTOBUS_TOOLS`:

- `promptobus_send`
- `promptobus_mailbox`
- `promptobus_task`

Each accepts an optional `task` id. Without it the server uses `PROMPTOBUS_TASK`, else the session binding, else the only active task.

`promptobus mcp` is JSON-RPC 2.0 over stdio (`lib/server.js`). Protocol versions the server accepts: `2025-06-18`, `2025-03-26`, `2024-11-05` (`lib/contract.js`).

### The MCP service: what the three tools do

Source: `src/mcp/service.ts`.

Promptobus service as the MCP layer sees it: the list of operations the
tools use. The list is explicit, not "the whole store", and that is the
point of the file — the boundary is visible to the eye, not inferred by
reading four modules. Operations take home as an argument: it arrives with
the process identity, and there is no second source for it.

The service is passed to the factory explicitly, and it has no default
implementation: half the list is the adapter's business, not the store.
Mailbox ownership, the "session → task" binding, active-task resolve, and
the `PROMPTOBUS_HOME=… · task=… · address=…` heading rest on session
identity, and only the adapter reads the environment. The consumer adapter
assembles the service.

Addresses, not participant ids. Bus tools talk in addresses: the address is
declared to the participant by their mcp-config, health and contact points
are keyed by it, and a person reads it. Translating an address into a v1
record id is the adapter's job — where the adapter lives.

### The stdio server: transport rules

Source: `src/mcp/server.ts`.

Bus MCP server: stdio transport, JSON-RPC 2.0 one message per line,
negotiation (`initialize` → `notifications/initialized` → `ping`),
`tools/list` and `tools/call`. The implementation is hand-rolled — the
package has no dependencies at all.

Protocol and dispatcher only. Everything that knows about the workspace,
harness, and consumer version arrives as callbacks: process identity, server
name and version, contact-point handoff, participant lines about Git and
the background session, stall diagnosis, and human error text. Callbacks
RETURN data and do not print: the stdout channel is taken by the protocol,
and one stray line in it breaks the client.

The package declares an error as a typed event; the consumer supplies the
text: JSON-RPC codes are part of the protocol and live here; the words are
part of the output and live at the adapter.

### The tool declarations

Source: `src/mcp/tools.ts`.

Bus MCP-server tool declarations: names, descriptions, and input schemas.
The home is here, not at the consumer: a tool description is part of the
protocol, and it must travel with the code that runs it. The set itself is
also declared on the CLI side (`PROMPTOBUS_TOOLS` at the consumer) — `lint`
takes it from there, checking the quote in the documentation; a live
`tools/list` check holds the two declarations together.

**The name prefix is double on purpose**: the full name a session sees is
`mcp__promptobus__promptobus_send`. The client namespaces names itself, and
short `send` and `task` collide with foreign ones in a shared session set.

### Rendering a reply for a participant

Source: `src/mcp/render.ts`.

Texts of bus-tool replies. The place is here, not at the consumer: these are
texts ABOUT CORRESPONDENCE — senders, types, participants, counts — and only
whoever knows the store can assemble them. Everything that knows about the
workspace arrives here through one `decorate` hook: participant lines about
the repository, worktree, and background session are assembled by the
adapter and handed over ready.

### The package entry point

Source: `src/index.ts`.

Public Promptobus surface, the "." entry point. It is **one** — protocol and store v1:
tasks, participants, messages, artifacts, recoverable fan-out, and history.
Alongside it go out the bus vocabulary, task-directory files the store does not
hold, former-root migration, the MCP factory, the driver contract, and the
warden state machine.

Raw filesystem helpers (atomic file and JSON writes) do not go out — they are
internal: a helper exported once becomes a contract, and the point of the
boundary is that the outside sees protocol, not disk. For the same reason the
store v1 paths are not visible outside: every operation goes through `openEngine`.

A constraint invisible from this file: package sources import only Node
built-ins and their own files. No consumer modules, no Git, no workspace
layout, no harness land here — standalone builds rest on that, and the
import-boundary gate watches it. It also watches the other direction:
`process.env`, `process.stdout`, `process.stderr`, and `console.` are forbidden
in package sources. **Diagnostics, session identity, and the harness name
arrive as ARGUMENTS** — the same way `home` and `policy` do for `openEngine`:
the environment and the output stay the adapter's business.

### The sidecar: state beside the journal

Source: `src/sidecar.ts`.

Task-directory files no store holds: participant contact points, delivery
health, the warden mark and log, stall and end-of-turn marks, session-to-task
bindings, and the participant files directory.

Why they live here, not in a store. The store is versioned — correspondence,
participants, and artifacts move with the protocol version. These files do
not belong to the protocol at all: the adapter names their format and is the
one that reads and writes them, and a migration copies them byte for byte.
A separate module makes that boundary visible: cutover replaced the store,
not these files.

Both stores name the task-directory layout (`<home>/tasks/<id>`) the same
way, so the path comes from [protocol.ts](../../src/protocol.ts) — the shared bus
dictionary.

### Migration: reading an older store

Source: `src/migrate.ts`.

Migration of the former store → `.promptobus`.

One-way and one-shot: there is no backup and no reverse migration, the old
CLI does not read the new store. From that follows the single requirement
that governs the whole step order — **a partially written new store never
exists**: it is assembled in a neighbouring temporary directory and takes
its place in one `rename`, and the legacy directory is removed only after.

Where to migrate from is declared by the host (`legacyLayout`). No layout —
nothing to move.

Order:

1. preflight — both roots at once, active tasks, a damaged root: a refusal
   BEFORE any mutation;
2. assemble in `<root>/.promptobus.migrating` — next to the target, so the
   `rename` is atomic;
3. `migrating.json` mark inside the assembled directory — before the switch;
4. `rename` the temporary directory to `.promptobus`;
5. remove the former directory, then the mark.

**The mark closes the window between 4 and 5.** A process death exactly
there would leave both roots, and "both roots at once" is a refusal; a
person would hit a wall on a clear path. The mark names the legacy
directory the new one was built from: while it is there, the migration
succeeded and a repeat just finishes cleanup. It is missing when this move
never happened or when cleanup completed; either case carries no cleanup
authority, so a side-by-side former root is refused. Releases before this
rule left a distinct completed-move record, so that old name is deliberately
not a resume token.

### The lock: what it guards and what it cannot

Source: `src/fs/lock.ts`.

Directory lock: task-journal read-modify-write sits under it, for both the
legacy store and protocol v1.

The lock is a directory, not a file: `mkdir` is atomic on every FS and does
not need a descriptor cleaned up; a second process gets `EEXIST` instead of
a quiet overwrite. A foreign lock is dropped only on a dead pid, never on a
guess about age.

Refusal wording did not move here and will not: the legacy store has its own
(`GateError` with a path for a person), v1 has its own (a typed code). The
module takes them as callbacks.

### Atomic writes

Source: `src/fs/atomic.ts`.

Atomic file write — a raw primitive shared by the legacy store and protocol v1.

Not exported: a helper exported once becomes a contract, and the point of the
boundary is that the outside sees protocol, not disk. There is no second copy
— v1 takes this same module.

### Reading about a process

Source: `src/fs/proc.ts`.

Process liveness and a synchronous pause. An internal package module: these
primitives are not exported — `pidAlive` goes out from `store.ts`, because it
has been part of that surface since earlier times.

### The legacy store, and the one reader it still lives for

Source: `src/legacy-store.ts`.

Bus store `v0.61.0` — a maildir store of a task. **It is no longer the
production store**: cutover moved the mechanism to protocol v1
([v1/](../../src/v1)), and what remains here is the one reader this code still
lives for — migration of the former store → `.promptobus`
([migrate.ts](../../src/migrate.ts)). The second caller is the suite: a legacy
slice is read by its own reader, and missing adapter files are written
into its copy through the same store API.

The surface goes out as the `legacy` namespace from [index.ts](../../src/index.ts).
It cannot be a flat export: both stores share the same names, and in a
common space they would collide. The home stays as long as the migration
input is read: the former-layout reader is its subject, and it can be
removed only together with the migration itself.

There is no daemon: each session has its own MCP-server stdio process,
shared state is on disk. One message = one JSON file in the addressee
mailbox, landing in place by an atomic rename; a mailbox has exactly one
consumer (address = process), so "read" is moving the file into read/.

The store path arrives as the `home` argument. Where it lives, the
package does not know at all: the workspace root is found by the adapter,
which also supplies diagnostics and session identity
([host.ts](../../src/host.ts)).

### `join` — entering a task: hand over the contact point and lift a listener

Source: `src/mcp/server.ts`, `join`.

Entering a task: hand over the contact point and lift a listener. Per
connection this is done ONCE per task — `joined` is that mark. A repeat
is not an error, but it is not work either: `onJoin` writes to the store
and lifts a process, and a session enters a task once per connection. The
key is the task id, not the address: an explicit `task` tool argument may
name another, and entering that one is lawful.

**The mark is set AFTER a successful enter and only for whoever handed
over a contact point.** The order is not cosmetic: `ownership` is the
first real read of the task journal (`resolveTaskId` only checks that it
exists), and on a wiped or unreadable journal it refuses. Marking enter
early, the server would remember as entered a session that did not enter
— and the next `tools/call` would skip enter, so the contact point would
never be handed over in the life of the session (review remark). The
ownership gate is the other half of the same: a foreign session does not
get a socket written (`joinBus`), but it may become the owner on the same
connection — `mailbox {claim: true}` — and the mark would keep
`wake/<address>.json` on the previous owner's socket until the end of the turn.
