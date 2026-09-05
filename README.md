# Promptobus

[Russian](README.ru.md)

Promptobus is a local mailbox and task bus for agent sessions. An orchestrator and workers exchange typed messages, artifacts, and status through an on-disk task. They do not share one chat transcript.

The package was extracted from a private agent-workspace tool so the bus can run on its own.

English is canonical. The Russian README is the only other language in this repository.

## Why

A split across sessions loses the assignment, the replies, and the files. Promptobus keeps them on disk under `.promptobus/`. A new session claims the mailbox and continues. Workers do not write to each other. Mail goes through the orchestrator.

The bus does not know your workspace. You pass a [host](docs/adr/adr-002-standalone-host-contract.md) into every call. The CLI builds a standalone host from the current directory, Git, and `promptobus.json`.

## Requirements

- Node.js 20 or newer (`package.json` `engines`)
- Git, for worktrees and freshness checks

## Install the package

From a clone of this repository:

```bash
npm install
npm run build
node bin/promptobus.js --version
```

The command prints `promptobus` and the version in `package.json`. After a global or `npx` install the same binary is `promptobus`.

As a library:

```bash
npm install promptobus
```

`package.json` exports `.`, `./host`, `./hooks`, `./driver`, `./cli`, and `./schemas/*`.

## Configure a workspace

Create `promptobus.json` at the workspace root. The standalone host walks up from the current directory to find it. The store is `.promptobus/` next to that file.

```json
{
  "tools": ["claude", "cursor", "codex"]
}
```

`tools` lists harnesses this workspace may spawn. `--harness` must name one of them. Without the flag, spawn and review use `claude` (`lib/drivers.js`).

`promptobus install` writes `harnesses` in the same file: the last installed hook list. That field is not the spawn allow-list.

Optional keys the standalone host reads: `commandName`, `locale`, `version`, `rules` (extra rule files), `mcp` (servers copied to a participant), `skills` (directory of process skills).

## Add the MCP server

The bus is an MCP stdio server:

```bash
promptobus mcp
```

Point the harness at that command. Set `PROMPTOBUS_HOME` to the store directory (the `.promptobus` folder). Spawn writes this entry for each worker and reviewer. The orchestrator session needs the same server.

Tools:

- `promptobus_send` — send a typed message (`task`, `status`, `question`, `answer`, `artifact`, `result`, `review`)
- `promptobus_mailbox` — read unread mail (this marks it read)
- `promptobus_task` — task metadata, participants, artifact directory

Full names the session sees are `mcp__promptobus__promptobus_send` and the same prefix for the other two (`lib/contract.js`).

## Install project hooks

Hook install is a separate command. It is not npm `postinstall`. See [docs/guides/install.md](docs/guides/install.md).

```text
promptobus install --harnesses claude,cursor,codex
promptobus install --check
promptobus install --dry-run
promptobus uninstall [--harnesses claude,cursor,codex]
```

Trust and troubleshooting: [docs/guides/hooks-and-trust.md](docs/guides/hooks-and-trust.md).

## Start

Write a brief file. Then:

```bash
promptobus spawn --repo ./my-repo --brief ./brief.md
promptobus status
```

`--repo` is a path on disk. `--brief` is required. `--new-task` opens a new task. `--task <id>` attaches to an existing one. `--title` names this worker's slice. `--task-title` names the task. `--harness cursor` or `--harness codex` selects the runtime. `--dry-run` prints the plan and writes nothing.

Isolated review:

```bash
promptobus review ./my-repo --title "Review the change"
```

The path is required. `--title` is required to open a new review task. Repeat with `--task <id>` to send a new diff to the same reviewer.

## Model routing

Name an intent — a strategy — instead of a model, and the CLI picks the `role + harness + model + effort` tuple for you: the rated catalog it ships, intersected with what your accounts can actually run right now, with every candidate and every reason printed.

```bash
promptobus models --strategy balanced          # what the resolver would pick, and why
promptobus spawn --repo my-repo --brief ./brief.md --strategy balanced
```

Real output on a machine with all three harnesses logged in, abridged at the `…` lines — nineteen candidates and the account's unrated models follow in the same shape:

```text
$ promptobus models --refresh
strategy: balanced · role: worker
snapshot: 2026-09-05T16:32:23.972Z · 0 s old · source probe
overlays: user (absent) · workspace (absent)
chosen: codex-luna-medium · codex / gpt-5.6-luna medium · score 73.10

candidates:
  * codex-luna-medium             codex / gpt-5.6-luna medium            available     73.10
    codex-sol-medium              codex / gpt-5.6-sol medium             available     71.85
    codex-mini-medium             codex / gpt-5.4-mini medium            available     63.10
    claude-sonnet-medium          claude / claude-sonnet-5 medium        unknown       62.50  (-10 unknown-availability)
    …

runtime models — not rated, never chosen automatically:
    claude / opus
    …

warnings:
  ! unknown-remaining: claude exposes no limit source — remaining counted as 50 % and the candidate penalised 10 points
```

The four strategies are `quality`, `balanced`, `speed` and `economy`. `models` reads the availability cache and asks no harness anything — `--refresh` is the only flag that probes, and therefore the only one that writes a cache entry. On `spawn` and `review`, `--strategy` hands the resolver an intent, while `--harness`, `--model` and `--effort` stay **constraints** on its choice and are never replaced by one. Without `--strategy` nothing is routed and the command takes its usual path.

`models validate` checks the shipped catalog and every overlay layer; `models --clear-exhausted <harness>` lifts an exhaustion the cache is holding with no known reset. The command surface is [Model routing](docs/reference/03-cli.md#model-routing); the catalog, the layers and the overlay file to copy are in [docs/guides/model-routing.md](docs/guides/model-routing.md).

## Commands

| Command | What it does |
|---|---|
| `promptobus spawn` | Start a worker in an isolated git worktree |
| `promptobus review` | Start a read-only reviewer on a path |
| `promptobus models` | What the resolver would pick now; `validate` checks the catalog, `--clear-exhausted <harness>` lifts a stuck exhaustion |
| `promptobus status` | List active tasks, participants, unread counts |
| `promptobus done` | Close a task. Stops sessions the bus started unless `--keep-sessions` |
| `promptobus dismiss <address>` | Stop watching a finished participant |
| `promptobus history` | Print **read** mail, oldest first (default last 50) |
| `promptobus prune` | Preview or delete journals of old closed tasks (default 14 days) |
| `promptobus guard` | Loop guard for the Stop hook. Exit 2 returns the turn |
| `promptobus warden` | Task listener. Any bus command starts it. `PROMPTOBUS_WARDEN=off` disables auto-start |
| `promptobus mcp` | MCP stdio server |
| `promptobus install` | Write project-level hooks (`--harnesses`, `--check`, `--dry-run`) |
| `promptobus uninstall` | Remove owned project-level hooks |

`promptobus help` and `promptobus --version` work without a host file.

## Library

```js
import { openEngine } from 'promptobus';
import { createStandaloneHost } from 'promptobus/host';
import { planPromptobusHooks } from 'promptobus/hooks';
```

`openEngine` needs a store location (`root` or `home`) and a routing policy. The engine does not search the disk for a workspace. See [docs/reference/01-overview.md](docs/reference/01-overview.md).

## Documentation

- [Install](docs/guides/install.md)
- [Hooks, trust, troubleshooting](docs/guides/hooks-and-trust.md)
- [Model routing: the catalog and overlays](docs/guides/model-routing.md)
- [Contribute (backslop)](docs/guides/contributing.md)
- [Host contract](docs/adr/adr-002-standalone-host-contract.md)
- [Glossary](docs/GLOSSARY.md)
- [Reference](docs/reference/README.md)
- Process skills: [skills/orchestrate](skills/orchestrate/SKILL.md), [skills/solo-review](skills/solo-review/SKILL.md)

## License

MIT
