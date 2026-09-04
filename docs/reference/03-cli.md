# CLI

Parser: `lib/cli.js`. Commands: `spawn`, `review`, `status`, `done`, `dismiss`, `history`, `prune`, `guard`, `warden`, `mcp`.

Help and `--version` do not load the standalone host. Every other command does.

## Spawn

Required: `--repo`, `--brief`. `--brief` is a file (`lib/spawn.js`).

`--harness` must be in `host.declaredTools()` when present. Without the flag the registry fallback is `claude` (`lib/drivers.js`). Unknown harness names fail before any disk write.

`--new-task` and `--task` conflict. Without `--task`, spawn joins the only active task, or opens a new one when several actives exist and this session has no binding. A task owned by another session refuses a silent join.

`--title` names the worker slice. `--task-title` names the task on create. `--dry-run` prints the plan.

The worker gets an isolated git worktree. The main tree is not edited. Read the branch from `promptobus status` or `promptobus_task`, not from the worktree name.

## Review

The path is required. There is no cwd resolve. `--title` is required to open a new review task. `--task` sends a new diff to the existing reviewer. `--base` sets the diff base. `--dry-run` prints the plan.

The reviewer is read-only. A harness that cannot deny tools must fail before spawn (`src/driver.ts` `denyTools`).

## Status, done, dismiss, history, prune

`status` lists active tasks, participants, unread counts, and warden health.

`done` closes the task. The mailbox owner may call it. Sessions the bus started are stopped unless `--keep-sessions`. Journals of tasks closed more than `PRUNE_DEFAULT_DAYS` (14) days ago are removed on that last call.

`dismiss <address>` drops a finished participant from watch.

`history` prints **read** mail, oldest first. Default limit 50. `--all` drops the limit. It does not mark mail read.

`prune` previews deletions. `--yes` deletes. `--older-than <days>` changes the age.

## Guard and warden

`guard` is the Stop-hook helper. Clean mailbox: exit 0, no output. Unread mail: exit 2, return the turn. Same state twice, then it warns and lets the turn end.

`warden` is the only listener for a task. Any bus command starts it. `PROMPTOBUS_WARDEN=off` disables auto-start. A knock carries at most `KNOCK_TEXT_MAX` (2000) characters of body text (`lib/contract.js`). Only `promptobus_mailbox` marks mail read.

## MCP

`promptobus mcp` serves stdio JSON-RPC. It must not write logs to stdout. The bus server name is `promptobus`.
