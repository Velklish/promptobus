---
name: orchestrate
description: Orchestrate a large task with worker sessions on Promptobus. Use when work splits across repositories or independent slices, and the user asks to spawn workers, run in parallel, or watch a worker. Start workers only after explicit approval. Not for a one-line edit, a read, or a question. Isolated review of one diff without workers is solo-review.
---

# Orchestrate

You hold the whole task. Workers edit isolated git worktrees. Mail goes through Promptobus. Workers do not write to each other.

A small change is not an orchestration. Do the work yourself.

Launch workers only after the user says yes to a named split. Silence is not approval.

## Roles

| Role | Who | Does | Does not |
|---|---|---|---|
| Orchestrator | you | Cut the work, write briefs, spawn, accept results | Edit a worker's tree |
| Worker | a session in a worktree | Change that tree, send `status` / `question` / `result` | Decide for you, open tracker files, talk to the user |
| Reviewer | `promptobus review` | Read a diff, send findings | Fix the findings |

## Tools

MCP server name: `promptobus`. Tools: `promptobus_send`, `promptobus_mailbox`, `promptobus_task`.

```
promptobus_send { to, type, body, artifactPath?, task? }
promptobus_mailbox { claim?, task? }
promptobus_task { task? }
```

`to` is `orchestrator`, `worker:<slug>`, or `reviewer:<slug>`. The address must already be a participant.

Types: `task`, `status`, `question`, `answer`, `artifact`, `result`, `review`.

Without `task`, the server uses `PROMPTOBUS_TASK`, else this session's binding, else the only active task. If the reply names another title, you joined the wrong task. Pass `task`.

A foreign-mailbox header means the originals stay with the owner. If the mail is yours and this session is new, `promptobus_mailbox { claim: true }`. Then read again without `claim`.

## CLI

```bash
promptobus spawn --repo <path> --brief <file> [--task <id> | --new-task] [--title <slice>] [--task-title <task>] [--slug <s>] [--worker <name>] [--harness <h>] [--dry-run]
promptobus status [--task <id>]
promptobus done [--task <id>]
promptobus dismiss <address> [--task <id>]
promptobus prune [--older-than <days>] [--yes]
promptobus warden [--task <id>]
promptobus review <path> [--task <id> | --title <name>] [--harness <h>]
```

`--harness` must be listed in `promptobus.json` `tools`. Without the flag the CLI uses `claude`.

`--repo` is a path on disk. `--brief` is required.

Read the worker branch from `promptobus status` or `promptobus_task`. Do not rebuild it from a name template. The worker may have switched branches. Publish the branch git reports.

## Mail

Do not wait on the bus. The warden knocks when mail arrives. A knock may carry body text up to 2000 characters (`KNOCK_TEXT_MAX`). Only `promptobus_mailbox` marks mail read. Call it even when the knock looks complete.

A lost knock loses nothing. The mail stays in the mailbox.

`PROMPTOBUS_WARDEN=off` disables the warden. Then participants must poll `promptobus_mailbox`.

The Stop guard (`promptobus guard`) returns the turn when the mailbox is unread. Same unread set twice, then it warns and lets the turn end. Empty the mailbox. Do not remove the hook.

## Worker protocol

A worker's first bus message is `status`: what it read, what it will do. Further `status` on every visible step. Background work longer than a couple of minutes is announced with volume and a measured estimate before the worker goes quiet.

A worker that cannot continue sends `question` and ends the turn. You answer with `answer`. Do not guess for the user.

When the worker is done it takes mailbox, then sends `result` (what changed, gates as numbers, what is still open). You review. Findings go back as `review`. The worker fixes and sends `result` again.

You do not merge the worker branch until you accept the result. The worker does not push and does not edit the main tree.

## Stops

`promptobus status` prints a stopped participant with a reason and a driver route. Follow that route. Do not invent a attach/stop command for a harness you have not read.

A line that says the process is gone is not a stop. Re-spawn by role: `promptobus spawn` for `worker:<slug>`, `promptobus review <path> --task <id>` for `reviewer:<slug>`. Spawn cannot create a reviewer address.

A participant who sent you mail and then ended the turn is waiting, not stopped.

## Not this skill

- One diff, no workers: [solo-review](../solo-review/SKILL.md)
- Contribution tracker: [docs/guides/contributing.md](../../docs/guides/contributing.md)
