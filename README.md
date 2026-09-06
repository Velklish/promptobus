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
promptobus models --strategy balance           # …and which of your subscriptions it would spend
promptobus spawn --repo my-repo --brief ./brief.md --strategy balanced
```

The shape of the output, abridged at the `…` lines. The numbers are the snapshot fixture the suite pins (`test/fixtures/model-routing/balance-snapshot.json`) run against the shipped catalog, so a reader can reproduce them; the percentages of a real account are that account's own:

```text
$ promptobus models --strategy balance
strategy: balance · role: worker
snapshot: 2026-09-06T02:17:43.464Z · 0 s old · source cache
overlays: user (absent) · workspace (absent)
chosen: codex-sol-medium · codex / gpt-5.6-sol medium · score 78.10

candidates:
  * codex-sol-medium        codex / gpt-5.6-sol medium       available     78.10
    claude-opus-medium      claude / claude-opus-5 medium    available     74.25
    codex-sol-high          codex / gpt-5.6-sol high         available     73.10
    claude-opus-high        claude / claude-opus-5 high      available     73.00
    …

pace — percentage points of each binding window · band 5.0 · spend unit 5.0:
  * codex   codex-sol-medium · secondary weekly · 46.0% used · 62.5% elapsed · underspend +16.50 · penalty -1.25 · effective +15.25
    claude  claude-opus-medium · 7d weekly · 30.0% used · 40.5% elapsed · underspend +10.48 · penalty -1.25 · effective +9.23
    cursor  cursor-composer-2.5 · cycle-auto monthly · 62.0% used · 47.9% elapsed · underspend -14.08 · penalty -1.25 · effective -15.33

availability:
  claude  available  tier example-max (credentials)
      5h        session 8.0% used · 18000 s · account · resets 2026-09-06T06:17:43.464Z
      7d        weekly  30.0% used · 604800 s · account · resets 2026-09-10T06:17:43.464Z
      7d-fable  weekly  38.0% used · 604800 s · model Fable · resets 2026-09-10T06:17:43.464Z
  cursor  available  tier included:2000 (derived)
      cycle-auto  monthly 62.0% used · 2592000 s · pool auto · resets 2026-09-21T17:17:43.464Z
      cycle-api   monthly 72.0% used · 2592000 s · pool api · resets 2026-09-21T17:17:43.464Z
  codex   available  tier example-pro (probe) · credits none · reset credits 2
      primary    session 0.0% used · 18000 s · account · resets 2026-09-06T04:17:43.464Z
      secondary  weekly  46.0% used · 604800 s · account · resets 2026-09-08T17:17:43.464Z

runtime models — not rated, never chosen automatically:
    cursor / gpt-5.6-via-cursor  [no-zdr]
    …
```

The five strategies are `quality`, `balanced`, `speed`, `economy` and `balance`. The first four weigh the qualities of a tuple. `balance` answers a different question — which of your subscriptions to spend — and it is the one to reach for when you pay for several harnesses and want them spent evenly: it prefers the harness furthest behind the pace of its own limit window, orders tuples inside a harness by `balanced`, and falls back to `balanced` with a warning when no window can be paced. The `availability:` block above it is what each account answered: its state, its tier, and every limit window with its kind, how much of it is gone, how long it is, what it binds and when it resets. The `pace` table is printed under `balance` only.

**Precedence: flag → overlay default → none.** `--strategy` on the command line always wins. Below it, `defaults.strategy` from the merged overlays — the recorded default. Below that, nothing: `spawn` and `review` route nothing and take their usual path, exactly as before. `--harness`, `--model` and `--effort` are not part of that ladder at all — they stay **constraints** on the resolver's choice and are never replaced by a strategy.

`models` reads the availability cache and asks no harness anything — `--refresh` is the only flag that probes, and therefore the only one that writes a cache entry.

When an account is running short, `models` prints a `near-limit` line: the window, its reset, whether the level or the rate tripped it, and the strategy to switch to. **Nothing switches on its own.** An agent proposes the switch to you; once you agree, `promptobus models strategy --set <name>` records `defaults.strategy` in the host's writable overlay so every following `spawn` and `review` without `--strategy` routes with it. `--clear` removes it, and `promptobus models strategy` alone prints the effective default and the layer it came from.

One question no harness method answers — Cursor's plan name — is a line you add once, to the `user` overlay under `account: { "cursor": { "plan": "<name>" } }`. Nothing writes it, and it is displayed and scored by nothing.

`models validate` checks the shipped catalog and every overlay layer; `models --clear-exhausted <harness>` lifts an exhaustion the cache is holding with no known reset. `promptobus done` appends one telemetry record per participant to `telemetry.jsonl` beside the availability cache — local, mode `0600`, never sent anywhere, and holding no prompt, path, session id or token; `models` prints how many records it holds. Run `promptobus models --refresh` right before `promptobus done` if you want that record to carry an end value for each window. The command surface is [Model routing](docs/reference/03-cli.md#model-routing); the catalog, the layers and the overlay file to copy are in [docs/guides/model-routing.md](docs/guides/model-routing.md).

## Commands

| Command | What it does |
|---|---|
| `promptobus spawn` | Start a worker in an isolated git worktree |
| `promptobus review` | Start a read-only reviewer on a path |
| `promptobus models` | What the resolver would pick now, and what each account has left; `strategy --set <name>` records the default a person agreed to, `validate` checks the catalog, `--clear-exhausted <harness>` lifts a stuck exhaustion |
| `promptobus status` | List active tasks, participants, unread counts |
| `promptobus done` | Close a task. Stops sessions the bus started unless `--keep-sessions`, and appends one local telemetry record per participant |
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
