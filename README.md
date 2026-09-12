# Promptobus

[![CI](https://github.com/Velklish/promptobus/actions/workflows/ci.yml/badge.svg)](https://github.com/Velklish/promptobus/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

Harness-neutral bus for agent sessions: tasks, mailboxes, artifacts and participant sessions.

[Russian](README.ru.md)

Promptobus lets one agent session — the orchestrator — hand work to other sessions and get it back. Workers edit isolated git worktrees, a reviewer reads a diff with fresh eyes, and all of them exchange typed messages, artifacts and status through a task kept on disk under `.promptobus/`. No session shares another's chat transcript, and a session that dies is replaced by one that claims the same mailbox and continues.

The bus does not know your workspace. Every call receives a **host** that answers for the current directory, Git and `promptobus.json`; the CLI builds a standalone one, and a consumer tool can pass its own. The package was extracted from a private workspace tool so that the bus can run on its own, and it drives Claude Code, Cursor and Codex sessions through one driver contract.

English is canonical. The Russian README is the only other language in this repository.

## Features

- **On-disk task store.** One directory per task: `task.json`, per-participant inboxes and history, artifacts as hard links to their blobs, and a `files/` folder a person can open. Seven message types — `task`, `status`, `question`, `answer`, `artifact`, `result`, `review` — and a JSON schema for every record shape.
- **Workers in worktrees.** `promptobus spawn` starts a session in an isolated git worktree of the target repository, hands it the brief and the bus, and leaves the main tree untouched.
- **Isolated review.** `promptobus review` starts a read-only reviewer on a snapshot of the diff; findings come back on the bus, and a repeat call sends the same reviewer a fresh snapshot.
- **Three harnesses, one contract.** Drivers for Claude Code, Cursor and Codex; `promptobus.json` lists which of them a workspace may spawn.
- **MCP server and hooks.** `promptobus mcp` exposes three tools over stdio. `promptobus install` writes the project-level hooks — bus feedback after each bus tool call and a Stop guard that returns the turn while mail is unread — and a warden wakes the addressee when mail arrives.
- **Model routing.** Name a strategy instead of a model and the resolver picks harness, model and effort from a rated catalog, intersected with what your accounts can run right now. Five strategies, overlay files for local overrides, and a calibration command that proposes overlay lines from your own telemetry.
- **A library, not only a CLI.** Engine, host contract, driver contract and hook planner are exported with TypeScript types; the bundled runtime also reuses the package's canonical atomic, quoting and process helpers through built implementation modules, and the package has no runtime dependencies.
- **Process skills included.** `skills/orchestrate` and `skills/solo-review` tell an agent how to run a split and how to ask for a review.

## Requirements

- Node.js 20 or newer
- Git — worktrees, diffs and freshness checks
- At least one harness CLI on `PATH` for `spawn` and `review`: Claude Code, Cursor (`cursor-agent`, plus `tmux`), or Codex
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

`tools` is the spawn allow-list: `--harness` must name one of them, and without the flag `spawn` and `review` use `claude`. Optional keys the host reads: `commandName`, `locale`, `version`, `rules` (extra rule files for participants), `mcp` (servers copied to a participant), `skills` (a directory of process skills). A repository that generates its own process skills declares the command in its own `promptobus.json` under `generate`, as an argv array.

### 2. Give the orchestrator the MCP server

Spawn writes an MCP entry for every worker and reviewer. The orchestrator session needs the same stdio server in the harness's project MCP file:

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

`--repo` is a path on disk and `--brief` is required. The worker gets a worktree, the brief and the bus; its first message is a `status`. Read mail from the orchestrator session with the `promptobus_mailbox` tool — the warden knocks when something arrives, and the Stop guard does not let a turn end while mail is unread. Answer a `question` with `promptobus_send`, accept a `result`, or send `review` findings back.

Ask for an independent reading of the diff:

```bash
promptobus review ./my-repo --title "Review the rename"
```

The path is required, `--title` opens a new review task, and `--task <id>` sends a new snapshot to a reviewer that is already up. Close the task when the work is accepted:

```bash
promptobus done
```

`done` stops the sessions the bus started (keep them with `--keep-sessions`), removes a mechanism-created worktree and its branch once the work is proven merged, and appends one local telemetry record per participant.

### Commands

| Command | What it does |
|---|---|
| `promptobus spawn --repo <path> --brief <file>` | Start a worker in an isolated git worktree. `--new-task` or `--task <id>`, `--title`, `--task-title`, `--harness`, `--model`, `--effort`, `--strategy`, `--dry-run` |
| `promptobus review <path>` | Start a read-only reviewer on a snapshot of the diff. `--title` or `--task <id>`, `--base <ref>`, `--strategy`, `--dry-run` |
| `promptobus models` | What the resolver would pick now and what each account has left. Subcommands `validate`, `strategy [--set <s> \| --clear]`, `calibrate [--write]`; `--clear-exhausted <harness>` |
| `promptobus status` | Active tasks: participants, unread mail, session state, routing and review-round counts |
| `promptobus done` | Close a task; stop bus-started sessions unless `--keep-sessions` |
| `promptobus stop <address>` | Close ONE participant's session and leave the task open; the session record goes with the process |
| `promptobus dismiss <address>` | Stop watching a finished participant — the watch only, the process is not touched |
| `promptobus history` | Journal of read mail, oldest first; `--limit <n>` or `--all` |
| `promptobus prune` | Preview journals of tasks closed more than 14 days ago; delete with `--yes` |
| `promptobus guard` | Loop guard for the Stop hook: exit 2 returns the turn while mail is unread |
| `promptobus warden` | Task listener. Any bus command starts it; `PROMPTOBUS_WARDEN=off` disables auto-start |
| `promptobus mcp` | MCP server over stdio |
| `promptobus install` / `uninstall` | Write or remove the project-level hooks |

`promptobus help` prints every flag; it and `--version` work without a `promptobus.json`.

### MCP tools

| Tool | Input | Does |
|---|---|---|
| `promptobus_send` | `{ to, type, body, artifactPath?, task? }` | Send a typed message; `to` is `orchestrator`, `worker:<slug>` or `reviewer:<slug>` |
| `promptobus_mailbox` | `{ claim?, task? }` | Read unread mail and mark it read; `claim: true` takes over a mailbox from a previous session |
| `promptobus_task` | `{ task? }` | Task metadata, participants, artifact directory |

The full names a session sees are `mcp__promptobus__promptobus_send` and the same prefix for the other two. Without `task` the server uses `PROMPTOBUS_TASK`, then the session's binding, then the only active task.

### Model routing

```bash
promptobus models --strategy balanced                       # the pick, every candidate, every reason
promptobus spawn --repo ./my-repo --brief ./brief.md --strategy quality
promptobus models strategy --set balance                    # record a default for later spawn and review
promptobus models calibrate                                 # propose overlay ratings from local telemetry
```

The strategies are `quality`, `balanced`, `speed`, `economy` and `balance`. The first four weigh the qualities of a `harness + model + effort` tuple; `balance` answers which of your subscriptions to spend, preferring the harness furthest behind the pace of its own limit window. Precedence is the flag, then the recorded overlay default, then nothing — a call without a strategy takes the unrouted path. `--harness`, `--model` and `--effort` are constraints on the resolver's choice and are never replaced.

`models` reads the availability cache and asks no harness anything; `--refresh` is the only flag that probes. When an account runs short it prints a `near-limit` line with the strategy to switch to, and nothing switches on its own. The cache and the telemetry file live under your home directory with mode `0600`, hold no prompt or token contents, and are never sent anywhere. Commands, reason codes and error codes: [reference/03-cli.md § Model routing](docs/reference/03-cli.md#model-routing); the catalog and the overlay file to copy: [guides/model-routing.md](docs/guides/model-routing.md).

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
| `promptobus/schemas/*` | JSON schemas for task, participant, message, artifact and the model-routing documents |

`openEngine` takes a store location (`root` or `home`) and a routing policy; it never searches the disk for a workspace. Package sources import only Node built-ins and never read `process.env` or write to stdout — diagnostics, session identity and the harness name arrive as arguments, so the environment and the output stay with the consumer. Details: [reference/01-overview.md](docs/reference/01-overview.md), [reference/02-host.md](docs/reference/02-host.md), [reference/04-protocol.md](docs/reference/04-protocol.md).

## Development

```bash
git clone https://github.com/Velklish/promptobus.git
cd promptobus
npm ci               # builds dist/ through prepare
npm run build        # tsc -p tsconfig.json
npm test             # test/run.mjs runs every test/*.test.mjs
npm run audit        # publicity audit over tracked files and the packed tarball
npm run lint:backslop
```

`src/` is TypeScript compiled to `dist/`; `lib/` is the JavaScript runtime and the three drivers; `skills/`, `templates/`, `schemas/` and `models/` ship in the tarball.

The suite needs `git`, `tmux` and `ast-grep` (`npm install -g @ast-grep/cli@0.45.3`, the version CI pins). It runs files in a process pool with the wall-clock files in a serial group at the end, gives every file its own home and temp directory, seals `PATH` to a directory of stubs so no real harness binary is reached, and refuses a run that leaves a process behind. Live harness runs are never started in CI. `lint:backslop` needs the generated adapter output, which a fresh checkout does not have — run `npx --yes github:Velklish/backslop#v0.6.0 init --prefix PB --lang en --tools claude,cursor,codex` first.

CI runs the same steps on Node 20 and 22, on Ubuntu and macOS ([ci.yml](.github/workflows/ci.yml)). The gates a change must pass are listed under `gates` in [backslop.json](backslop.json): `npm test`, `backslop lint`, `npm run audit`.

## Contributing

Tasks and decisions live in `docs/` and are managed with [backslop](https://github.com/Velklish/backslop); `npx github:Velklish/backslop#v0.6.0 status` prints the queue. A change is complete when the reference, the affected README and `CHANGELOG.md` move with it and every gate above exits 0. Commit subjects start with the task number: `PB-N: <what was done>`. New strings, comments and checks in `bin/`, `lib/`, `src/`, `schemas/` and `templates/` are English, and nothing names an internal product or links into another repository. Full procedure: [docs/guides/contributing.md](docs/guides/contributing.md).

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
