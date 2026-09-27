# Promptobus

[![CI](https://github.com/Velklish/promptobus/actions/workflows/ci.yml/badge.svg)](https://github.com/Velklish/promptobus/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

Harness-neutral bus for agent sessions: tasks, mailboxes, artifacts and participant sessions.

[Russian](README.ru.md)

Promptobus lets one agent session — the orchestrator — hand work to other sessions and get it back. Workers edit isolated git worktrees, a reviewer reads a diff with fresh eyes, an approver accepts one green piece, and all of them exchange typed messages, artifacts and status through a task kept on disk under `.promptobus/`. No session shares another's chat transcript, and a session that dies is replaced by one that claims the same mailbox and continues.

The bus does not know your workspace. Every call receives a **host** that answers for the current directory, Git and `promptobus.json`; the CLI builds a standalone one, and a consumer tool can pass its own. The package was extracted from a private workspace tool so that the bus can run on its own, and it drives Claude Code, Cursor and Codex sessions through one driver contract.

English is canonical. The Russian README is the only other language in this repository.

## Features

- **On-disk task store.** One directory per task: `task.json`, per-participant inboxes and history, artifacts as hard links to their blobs, and a `files/` folder a person can open. A task may have a root parent; `status` shows its children and `done` waits for each child to close. Seven message types — `task`, `status`, `question`, `answer`, `artifact`, `result`, `review` — and a JSON schema for every record shape.
- **Task digest.** `digest` prints the root and child tasks, each participant's latest status first line, questions and their age across linked roots, answer debts, and pieces by their current pipeline step. Peer messages record their origin task, so a later same-slug link cannot answer an older root's question. A legacy question whose origin is unknown is marked `UNRESOLVED PROVENANCE`. `--json` carries the same page for scripts without starting a harness.
- **Governance routes.** Registered teamleads of the same root exchange `question`, `answer`, `status` and `artifact` directly. `link` registers two root tasks as peers; a send to one peer enters the other root's orchestrator mailbox under the source peer address. `user` asks a root or child orchestrator by `question`, receives `answer` or `status`, and `reporter` never sends as itself. Its restricted ask tool writes as `user`. Other traffic follows the root orchestrator. The [route table](docs/reference/04-protocol.md#addresses) gives each decision; `ask` registers `user` on first use.
- **Workers in worktrees.** `promptobus spawn` starts a session in an isolated git worktree of the target repository, hands it the brief and the bus, and leaves the main tree untouched.
- **Teamleads for child tasks.** `promptobus spawn --teamlead --brief ./group.md --task <root>` lifts a Claude Code orchestrator at the install root. It owns one child task, reports to the root as `teamlead:<slug>`, and repairs an interrupted lift on retry. A relift updates both addresses to the new session; a dry-run leaves a pending repair untouched.
- **Reporter for the person.** `promptobus report --task <root>` lifts one read-only Claude Code session at the install root. It answers from the tree digest and journals in its own window, or asks the root orchestrator as `user` through its restricted MCP tool.
- **Declared gate lifts.** `promptobus step <name> <path> --task <id>` lifts a named gate after the required earlier results are on record. `review` selects the first read-only gate; a repeat sends its participant a fresh snapshot.
- **Addressed acceptance.** `review <path> --task <id> --approver` lifts the first `writes-main-tree` gate after the preceding participant and owner have reported. It accepts the piece in its own worktree and advances the clone root only with a fast-forward. Its registered address can talk directly to the owner step in that task while the calling session holds it through a session id or validated record pointer, and the canonical exchange stays in the task journal.
- **Three harnesses, one contract.** Drivers for Claude Code, Cursor and Codex; `promptobus.json` lists which of them a workspace may spawn.
- **MCP server and hooks.** `promptobus mcp` exposes six tools over stdio, including three restricted to a proven reporter session. `promptobus install` writes the project-level hooks — bus feedback after each bus tool call and a Stop guard that returns the turn while mail is unread, or while an answer the participant owes has not been sent, including a user question in another task it orchestrates — and a warden wakes the addressee when mail arrives. Which types ask for an answer is a published table. `status` prints `UNANSWERED` after an ordinary participant's turn ends owing one, or as soon as an orchestrator receives a question from `user`.
- **Model routing.** Name a strategy instead of a model and the resolver picks harness, model and effort from a rated catalog, intersected with what your accounts can run right now. Five strategies, overlay files for local overrides, and a calibration command that proposes overlay lines from your own telemetry.
- **A library, not only a CLI.** Engine, host contract, driver contract and hook planner are exported with TypeScript types; the bundled runtime also reuses the package's canonical atomic, quoting and process helpers through built implementation modules, and the package has no runtime dependencies.
- **Process skills included.** `promptobus install` lays out `skills/orchestrate` and `skills/solo-review` into the project skill location of each selected harness and owns them. The orchestration skill gives the measured thresholds for a flat task or a two-level tree, teamlead escalation rules and the reporter's journal-answering contract; the review skill tells an agent how to ask for a review.

## Requirements

- Node.js 20 or newer
- Git — worktrees, diffs and freshness checks
- At least one harness CLI on `PATH` for `spawn` and `review`: Claude Code, Cursor (`cursor-agent`, plus `tmux`), or Codex
- Participant sessions are lifted on macOS and Linux. **Windows is outside the participant contract** (owner decision, 2026-09-16): the Cursor participant is a tmux pane and the Codex holder is an app-server process measured on macOS only, and neither is adapted, probed or promised on Windows. The CLI itself, including the host layer, stays cross-platform.
- For working on the package itself: `tmux` and `ast-grep` (see [Development](#development))

## Installation

The package is not on the npm registry. Install it from GitHub, pinned to a release tag from [CHANGELOG.md](CHANGELOG.md):

```bash
npm install github:Velklish/promptobus#v<version>
```

Add `-g` to get the `promptobus` command on `PATH`. From a clone:

```bash
npm install
npm run build
node bin/promptobus.js --version
```

The last command prints `promptobus` and the version from `package.json`.

### 1. Declare the workspace

Create `promptobus.json` at the workspace root. The standalone host walks up from the current directory to find it and keeps the store in `.promptobus/` beside it — add that directory to `.gitignore`.

```json
{
  "tools": ["claude", "cursor", "codex"]
}
```

`tools` is the spawn allow-list: `--harness` must name one of them, and without the flag `spawn` and `review` use `claude`. Optional keys the host reads: `commandName`, `locale`, `version`, `rules` (extra rule files for participants), `mcp` (servers copied to a participant), `skills` (a directory of process skills), `pipeline` (the owner step and the gates a piece passes after it — [install § 2](docs/guides/install.md#the-pipeline)). A repository that generates its own process skills declares the command in its own `promptobus.json` under `generate`, as an argv array.

### 2. Give the orchestrator the MCP server

Participant lifts write an MCP entry for workers, reviewers and approvers. The orchestrator session needs the same stdio server in the harness's project MCP file:

```json
{
  "mcpServers": {
    "promptobus": {
      "type": "stdio",
      "command": "promptobus",
      "args": ["mcp"],
      "env": { "PROMPTOBUS_HOME": "/absolute/path/to/workspace/.promptobus" }
    }
  }
}
```

Without a global install, `command` is `node` and `args` is `["/absolute/path/to/bin/promptobus.js", "mcp"]`. The server name must stay `promptobus`: hook matchers and tool names are built from it.

### 3. Install the project hooks

Hook install is a separate command, not an npm `postinstall`:

```bash
promptobus install --harnesses claude,cursor,codex   # the list is required on the first install
promptobus install --check                          # exit 1 when the project files drifted
promptobus install --dry-run                        # print the pending writes, write nothing
promptobus uninstall                                # remove owned hooks only
```

The installer edits `.claude/settings.json`, `.cursor/hooks.json` and `.codex/hooks.json`, keeps foreign hooks and unknown fields, and records the installed list as `harnesses` in `promptobus.json` — that field is not the spawn allow-list. Trust the project hooks in your harness afterwards: [Hooks, trust, and troubleshooting](docs/guides/hooks-and-trust.md).

## Usage

### Quick start

Write a brief — a Markdown file with the assignment — then:

```bash
promptobus spawn --repo ./my-repo --brief ./brief.md --task-title "Rename the billing module"
promptobus status
```

`--repo` is a path on disk and `--brief` is required. The worker gets a worktree, the brief and the bus; its first message is a `status`. `--worker <slug>` keeps its flag name when a pipeline renames the owner: an owner named `builder` is addressed as `builder:<slug>`, and the default remains `worker:<slug>`. Read mail from the orchestrator session with the `promptobus_mailbox` tool — the warden knocks when something arrives, and the Stop guard does not let a worker's turn end while mail is unread or while it owes an answer it has not sent. Answer a `question` with `promptobus_send`, accept a `result`, or send `review` findings back.

Ask for an independent reading of the diff:

```bash
promptobus review ./my-repo --title "Review the rename"
```

The path is required, `--title` opens a new review task, and `--task <id>` sends a new snapshot to a reviewer that is already up. On a declared pipeline, lift a gate by name after its predecessor reports:

```bash
promptobus step security ./my-repo --task <id>
```

A Cursor reviewer mechanically denies file and shell writes. External MCP writes are constrained by its review prompt; the Cursor driver has no verified mechanical MCP deny rule. See [03-cli § Review](docs/reference/03-cli.md#review).

Close the task when the work is accepted:

```bash
promptobus done
```

`done` stops the sessions the bus started (keep them with `--keep-sessions`), removes a mechanism-created worktree and its branch once the work is proven merged, and appends one local telemetry record per participant. It removes contact points for closed tasks and the files of dead, slugged participants; a sessionless `user` keeps its journal and mail without needing participant files.

An approver does its squash, gates, archive and acceptance commit in a separate worktree based on local main. Cursor loads its approver MCP entry, permission rules and hooks from `.cursor/` in that worktree. If its session is gone or stale, `status` gives the relift command for the recorded review subject with `--approver`. After the final commit, it verifies the clone root is on main and runs `promptobus lease --key <clone> -- git -C <clone> merge --ff-only <approver branch>`. The keyed lease keeps bus publishers out of the same clone index at once, even if a lease wrapper dies while its publication command runs. If main moved, it redoes the squash on current main and reruns gates before retrying. `sweep` and `done` remove the approver's worktree and branch after the branch is taken and its session has stopped.

### Commands

| Command | What it does |
|---|---|
| `promptobus spawn --repo <path> --brief <file>` | Start a worker in an isolated git worktree. A worker name that shares files with an existing task participant is refused. `--new-task` or `--task <id>`, `--title`, `--task-title`, `--harness`, `--model`, `--effort`, `--strategy`, `--dry-run` |
| `promptobus spawn --teamlead --brief <file> --task <root>` | Start a child-task orchestrator at the install root on Claude Code. `--slug`, `--strategy`, `--model`, `--effort`, `--dry-run` |
| `promptobus step <name> <path> --task <id>` | Lift the named declared gate when the preceding participant's result is on record for this subject; a main-tree writer also needs the owner's result. `--base <ref>`, `--brief <file>` for a writer, routing flags, `--dry-run` |
| `promptobus review <path>` | Lift the first `reads-diff` gate on a snapshot of the diff; `--approver` selects the first `writes-main-tree` gate. `--title` or `--task <id>`, `--base <ref>`, `--strategy`, `--dry-run` |
| `promptobus report --task <root>` | Lift one read-only Claude Code reporter at the install root. Routing flags and `--dry-run` are supported; a child task or second live reporter is refused |
| `promptobus models` | What the resolver would pick now and what each account has left. Subcommands `validate`, `strategy [--set <s> \| --clear]`, `calibrate [--write]`; `--clear-exhausted <harness>` |
| `promptobus status` | The machine lease, then active roots with their child tasks: participants by piece and declared step order, unread mail, session state, missing-session diagnostics, routing and review-round counts |
| `promptobus digest [--task <id>] [--json]` | A read-only page of active task trees or the selected task's root tree: latest status lines, questions with open or unresolved provenance state, stalls, `SILENT` and `UNANSWERED`, and pieces by current pipeline step |
| `promptobus send <address>` | Write one message as the address this session holds in the task; `--body` or `--file`, `--type`, `--task`, `--artifact`. There is no `--from` |
| `promptobus link <task-a> <task-b>` | Register two active root tasks as peers, from the owner session of either task |
| `promptobus unlink <task-a> <task-b>` | Remove the reciprocal peer records, or the surviving record after one journal is pruned; earlier mail remains in surviving journals |
| `promptobus ask "<text>" --task <id>` | Ask as `user` from a plain terminal; a participant's harness identity, including an MCP session record, is refused. `--to teamlead:<slug>` asks that child task's orchestrator. `ask --answers --task <id>` prints and consumes the user mailbox |
| `promptobus done` | Close a task; stop bus-started sessions unless `--keep-sessions` |
| `promptobus stop <address>` | Close ONE participant's session, including a declared step, and leave the task open; the session record goes with the process |
| `promptobus sweep <address>` | Clean up after ONE accepted piece, including a declared step, and leave the task active: its own worktree and branch when the merge is provable, the blobs and files it sent, its files in `workers/`. A main-tree gate cannot remove the owner's worktree |
| `promptobus dismiss <address>` | Stop watching a finished participant, including a declared step — the watch only, the process is not touched |
| `promptobus history` | Journal of read mail, oldest first; `--limit <n>` or `--all` |
| `promptobus prune` | Preview journals of tasks closed more than 14 days ago; delete with `--yes` |
| `promptobus guard` | Loop guard for the Stop hook: exit 2 returns the turn while mail is unread — in this task or in another task this session orchestrates — or while an owed answer has not been sent |
| `promptobus warden` | Task listener. Any bus command starts it; `PROMPTOBUS_WARDEN=off` disables auto-start |
| `promptobus lease -- <command…>` | Run one measuring command per machine at a time; a waiter names the lease holder and gives up at `--wait` (default 1800 s); `status` names the holder |
| `promptobus mcp` | MCP server over stdio |
| `promptobus install` / `uninstall` | Write or remove the project-level hooks |

`promptobus help` prints every flag; it and `--version` work without a `promptobus.json`.

### MCP tools

| Tool | Input | Does |
|---|---|---|
| `promptobus_send` | `{ to, type, body, artifactPath?, task? }` | Send a typed message to a registered participant. The tool description lists the installation's active pipeline steps; the [route table](docs/reference/04-protocol.md#addresses) decides which pair and type are allowed. The sender is the address this session holds in that task |
| `promptobus_mailbox` | `{ claim?, message?, task? }` | Without `message` it lists headers and marks them read; with `message` it returns that one body and marks nothing. On the orchestrator address, a call that names no session gets a copy, leaves the originals, and the reply says so. `claim: true` takes over a mailbox from a previous session |
| `promptobus_task` | `{ task? }` | Task metadata, participants, artifact directory |
| `promptobus_digest` | `{ task? }` | Reporter only: the root tree as `digest --json` |
| `promptobus_status` | `{ task? }` | Reporter only: the root tree status and live session state |
| `promptobus_ask` | `{ body?, answers?, after?, task? }` | Reporter only: ask as `user`; read later answers without consuming the user mailbox |

The full names a session sees are `mcp__promptobus__promptobus_send` and the same prefix for the other tools. Without `task` the server uses `PROMPTOBUS_TASK`, then the session's binding, then the only active task.

A worker sends an artifact named by its result before sending that result, reads the landed filename from the immediate reply to its own `promptobus_send` call, and uses it in the header without ending the turn. The bus may number a colliding filename; reviewers cannot attach files.

### Model routing

```bash
promptobus models --strategy balanced                       # the pick, every candidate, every reason
promptobus models --role security --strategy economy        # a declared reads-diff step
promptobus spawn --repo ./my-repo --brief ./brief.md --strategy quality
promptobus models strategy --set balance                    # record a default for later spawn and review
promptobus models calibrate                                 # propose overlay ratings from local telemetry
```

The catalog roles are worker, reviewer and approver, with soft quality floors 5, 9 and 7. `models --role` also accepts a declared step name: the step kind supplies its catalog role, and an explicit floor in the declaration takes precedence over that role's floor. The strategies are `quality`, `balanced`, `speed`, `economy` and `balance`. The first four weigh the qualities of a `harness + model + effort` tuple; `balance` answers which of your subscriptions to spend, preferring the harness furthest behind the pace of its own limit window. Precedence is the flag, then the recorded overlay default, then nothing — a call without a strategy takes the unrouted path. `--harness`, `--model` and `--effort` are constraints on the resolver's choice and are never replaced.

`ROUTED_ROLES` in the catalog is the runtime source for catalog roles; the host's role registry adds declared step names to routing and overlay validation. Routing decisions and telemetry records carry both names, while calibration shows per-step counts without adding step-specific catalog ratings. `orchestrator` and other addressed-but-unrouted roles are rejected where routing policy or selection names a role and excluded from routing projections.

`models` reads the availability cache and asks no harness anything; `--refresh` is the only flag that probes. When an account runs short it prints a `near-limit` line with the strategy to switch to, and nothing switches on its own — that line is a pace measurement and falls silent under the strategy it would propose, which is not the same fact as `unknown-remaining`, the harness exposing no limit source at all or its cached windows having expired. A tuple whose binding window is 90 % used or more leaves automatic selection as `window-nearly-spent`, unless `--harness` or `--model` names it. The cache and the telemetry file live under your home directory with mode `0600`, hold no prompt or token contents, and are never sent anywhere. The telemetry record does not promise spend for an attached session; Codex rollout token usage is deliberately not imported into the throughput sidecar because the rollout is outside the bus and lacks model-active time. Commands, reason codes and error codes: [reference/03-cli.md § Model routing](docs/reference/03-cli.md#model-routing); the catalog and the overlay file to copy: [guides/model-routing.md](docs/guides/model-routing.md).

`import { telemetryStats } from 'promptobus/telemetry'` exposes the typed descriptive per-role run summary: it derives wall-clock time, bus-message counts, close-time mailbox timing and the bottleneck role from persisted rows. Run-wide quota deltas stay in `quotaEvidence` with harness/window coverage; a role's `quotaCostPercent` remains null and its state is `ambiguous` or `unavailable` because overlapping participants cannot be assigned that delta, with `ambiguous` coming only from validated measured quota coverage; a same-harness record with no matching window counts as unavailable, malformed windows contribute no quota evidence, and a missing or invalid scope is not treated as account-wide. Per-role numeric totals require complete record coverage, and bottleneckRole is null when wall-clock coverage is incomplete. Missing attached-session spend, model turns and model-active time remain unavailable; the CLI still prints only telemetry count and size.

### Environment

| Variable | Effect |
|---|---|
| `PROMPTOBUS_HOME` | Store directory for a process that already knows it — what spawn sets for a participant's MCP server |
| `PROMPTOBUS_TASK` | Task id the MCP tools use when the call names none |
| `PROMPTOBUS_WARDEN=off` | Disable the warden auto-start; participants then poll `promptobus_mailbox` |

## Library

```js
import { openEngine, PROTOCOL_VERSION } from 'promptobus';
import { createStandaloneHost } from 'promptobus/host';
import { planPromptobusHooks } from 'promptobus/hooks';
import { createRegistry } from 'promptobus/driver';
import { runPromptobus } from 'promptobus/cli';
```

| Specifier | Contents |
|---|---|
| `promptobus` | Protocol and store v1: `openEngine`, tasks, participants, messages, artifacts, recoverable fan-out, history; the MCP factory; host and driver types |
| `promptobus/host` | The `PromptobusHost` contract and `createStandaloneHost` |
| `promptobus/hooks` | Hook planner: the bus feedback and guard hooks a harness file needs |
| `promptobus/driver` | Driver contract, `createRegistry`, session helpers, model-routing types |
| `promptobus/cli` | `runPromptobus(argv, { host, cwd, env, input, output })` |
| `promptobus/schemas/*` | JSON schemas for task, participant, message, artifact, the gate record, the handover record and the model-routing documents |

`openEngine` takes a store location (`root` or `home`) and a routing policy; it never searches the disk for a workspace. Package sources import only Node built-ins and never read `process.env` or write to stdout — diagnostics, session identity and the harness name arrive as arguments, so the environment and the output stay with the consumer. Details: [reference/01-overview.md](docs/reference/01-overview.md), [reference/02-host.md](docs/reference/02-host.md), [reference/04-protocol.md](docs/reference/04-protocol.md).

For a participant's MCP child whose harness omits its session variable, the driver puts a session-record pointer in the generated bus entry and binds the participant to it before launch. The adapter accepts the pointer only when record and process resolve to the same physical home and name the exact task and address, even if the harness id is still null. Claude Code receives a preselected session UUID through `--session-id`. An orchestrator entry without a pointer has no session identity in the measured Codex and Cursor MCP child paths, so its mailbox call returns a copy and leaves the originals unread. See [02-host § Session identity](docs/reference/02-host.md#session-identity) and [ADR-014](docs/adr/adr-014-mcp-session-proof.md).

## Development

```bash
git clone https://github.com/Velklish/promptobus.git
cd promptobus
npm ci               # builds dist/ through prepare
npm run build        # tsc -p tsconfig.json
npm test             # test/run.mjs runs every test/*.test.mjs
npm run audit        # publicity audit over tracked files and the packed tarball
npm run schema-skew  # record schemas against the installed package; not a project gate
npm run lint:backslop
```

`src/` is TypeScript compiled to `dist/`; `lib/` is the JavaScript runtime and the three drivers; `skills/`, `templates/`, `schemas/` and `models/` ship in the tarball.

The suite needs `git`, `tmux` and `ast-grep` (`npm install -g @ast-grep/cli@0.45.3`, the version CI pins). It runs files in a process pool with the wall-clock files in a serial group at the end, gives every file its own home and temp directory, seals `PATH` to a directory of stubs so no real harness binary is reached, and refuses a run that leaves a process behind. At the same boundary it removes every known harness identity before fixtures install their own, so running the suite from a participant of another harness does not create a second session identity. Live harness runs are never started in CI. `lint:backslop` needs the generated adapter output, which a fresh checkout does not have — run `npx --yes github:Velklish/backslop#v0.10.1 init --prefix PB --lang en --tools claude,cursor,codex` first.
The Cursor adapter's event-loop test uses a fixed 100 ms delay in each of its two stub replies, so its `ticks` check does not depend on process startup speed; this delay is test-only.

Socket-dependent groups probe their local listener before starting child processes. A sandbox refusal is a named skip only when the failure is the `listen` syscall with `EACCES` or `EPERM`; another error stays red. Skips never count as passes: the runner lists their checks and files, and its final summary calls out every file with zero passed checks so a wholly skipped suite cannot look fully exercised. Where local sockets are available, the probe succeeds and the original integration assertions run.

CI runs the same steps on Node 20 and 22, on Ubuntu and macOS ([ci.yml](.github/workflows/ci.yml)). The gates a change must pass are listed under `gates` in [backslop.json](backslop.json).

## Contributing

Tasks and decisions live in `docs/` and are managed with [backslop](https://github.com/Velklish/backslop); `npx github:Velklish/backslop#v0.10.1 status` prints the queue. A change is complete when the reference, the affected README and `CHANGELOG.md` move with it and every gate above exits 0. Commit subjects start with the task number: `PB-N: <what was done>`. New strings, comments and checks in `bin/`, `lib/`, `src/`, `schemas/` and `templates/` are English, and nothing names an internal product or links into another repository. Full procedure: [docs/guides/contributing.md](docs/guides/contributing.md).

## Documentation

- [Install](docs/guides/install.md) — package, workspace file, MCP server, project hooks
- [Hooks, trust, and troubleshooting](docs/guides/hooks-and-trust.md)
- [Model routing: the catalog and overlays](docs/guides/model-routing.md)
- [Reference](docs/reference/README.md) — overview, host, CLI, protocol
- [Glossary](docs/GLOSSARY.md) and [Roadmap](docs/ROADMAP.md)
- [Documentation index](docs/README.md) — guides, reference and the decision records
- Process skills: [orchestrate](skills/orchestrate/SKILL.md), [solo-review](skills/solo-review/SKILL.md)
- [CHANGELOG.md](CHANGELOG.md)

## License

[MIT](LICENSE)
