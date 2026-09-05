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
promptobus spawn --repo <path> --brief <file> [--task <id> | --new-task] [--title <slice>] [--task-title <task>] [--slug <s>] [--worker <name>] [--harness <h>] [--strategy <s>] [--allow-payg] [--dry-run]
promptobus status [--task <id>]
promptobus done [--task <id>]
promptobus dismiss <address> [--task <id>]
promptobus prune [--older-than <days>] [--yes]
promptobus warden [--task <id>]
promptobus review <path> [--task <id> | --title <name>] [--harness <h>] [--strategy <s>] [--allow-payg]
promptobus models [--strategy <s>] [--role <worker|reviewer>] [--refresh] [--json]
```

`--harness` must be listed in `promptobus.json` `tools`. Without the flag the CLI uses `claude`.

`--strategy` is one of `quality`, `balanced`, `speed`, `economy`. Without it the command routes nothing and takes the defaults. See [Model routing](#model-routing).

`--repo` is a path on disk. `--brief` is required.

Read the worker branch from `promptobus status` or `promptobus_task`. Do not rebuild it from a name template. The worker may have switched branches. Publish the branch git reports.

## Model routing

`auto` is not a CLI value. You classify the task and hand `spawn` or `review` one concrete `--strategy`.

### The rubric

| The track is | Strategy |
|---|---|
| A contract, an architecture change, security, a data migration, an incident — or a task whose statement is still ambiguous | `quality` |
| Ordinary development: a feature in a known subsystem, a bug with a repro, tests for behaviour that already exists | `balanced` |
| Reconnaissance, reading a subsystem, and a small precise change in a named file | `speed` |
| Bulk low-risk routine: a mechanical rename, a mass import rewrite, a formatting sweep | `economy` |

**The price of a mistake moves a track up one row**, in that order: `economy` → `speed` → `balanced` → `quality`. A mechanical rename that touches a published surface is `speed`. A small precise change in a payment or auth path is `balanced`. Ambiguity is already priced in — an unclear statement is `quality` outright, not one row up from where its subject would sit.

Classify each track on its own. One run may spawn `quality` and `economy` side by side.

### The strategy envelope

Agree the envelope with the user before the first spawn, in the same approval as the split. It names three things:

- the strategy of each track;
- the harnesses the run may use;
- whether pay-as-you-go is allowed (`--allow-payg`).

A fallback **inside** the envelope needs no second approval: a preflight that excludes the first candidate moves to the next one on an allowed harness, and the user already approved that. **Leaving** the envelope does need one — another harness, pay-as-you-go they did not allow, a strategy other than the one agreed for that track. Ask; do not widen it yourself.

`promptobus models [--strategy <s>] [--role <worker|reviewer>]` is how you see what a strategy would pick before spawning. Show it when you propose the envelope. It reads the availability cache; `--refresh` probes the harnesses instead. On `spawn` and `review`, `--dry-run` reads the cache and starts nothing.

`promptobus status` prints the strategy, tuple, snapshot age and warnings of every routed participant. Audit the envelope there during the run, not only at its start.

### Constraints the user named

An explicit `--harness`, `--model` or `--effort` from the user travels to the CLI unweakened. **Never rewrite a named model into a strategy**, and never pass a strategy as its alternative: a named value is a constraint the resolver applies, and the CLI ends with diagnostics rather than substituting when it cannot be met. Report those diagnostics to the user; do not pick something else for them.

### Step up after two rounds

Two review rounds on one worker with no progress — the same findings return, or a fix breaks what it fixed — mean the model is under the task. Step up once, and only once, without asking again if it stays inside the envelope:

1. the next strategy up the rubric, or
2. an explicit `--harness` / `--model` / `--effort` tuple you name.

Re-spawn that track. Name the step-up and its reason in the run's result: a run that quietly cost more than its envelope is not auditable.

A consumer layers its own policy on top of this rubric — which models it forbids, where its reviewer runs. That belongs in the consumer's own skills, not here.

Flags, reason codes and error codes: [reference/03-cli.md](../../docs/reference/03-cli.md) § Model routing. The catalog and overlays: [guides/model-routing.md](../../docs/guides/model-routing.md).

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
