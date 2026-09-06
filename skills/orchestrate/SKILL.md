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

`--strategy` is one of `quality`, `balanced`, `speed`, `economy`, `balance`. Without it the command takes the recorded default if there is one, and otherwise routes nothing and takes the defaults. See [Model routing](#model-routing).

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
| You pay for several harnesses and want them spent evenly — spend from the account that is behind the pace of its own window rather than from the best-rated one | `balance` |

**The price of a mistake moves a track up one row**, in that order: `economy` → `speed` → `balanced` → `quality`. A mechanical rename that touches a published surface is `speed`. A small precise change in a payment or auth path is `balanced`. Ambiguity is already priced in — an unclear statement is `quality` outright, not one row up from where its subject would sit.

Classify each track on its own. One run may spawn `quality` and `economy` side by side.

`balance` is not a row of the quality ladder and does not move with the price of a mistake: it answers which ACCOUNT to spend from, and orders tuples inside a harness by `balanced`. It is the strategy for a person paying several subscriptions who wants the work spread over all of them instead of exhausting one — reach for it when `models` says an account is running short, or when the run is long enough that the spend matters, not as a general default. The reviewer is inside it like a worker: **nothing in this package pins the reviewer to a harness** ([solo-review](../solo-review/SKILL.md) § Reviewer strategy).

### When `models` says an account is running short

A `near-limit` line in `promptobus models` names a harness whose limit window is at or past its threshold, or which is spending faster than the window refills, and it names the strategy it would switch to — `economy` when every paced account is short, `balance` when at least one has room.

**Propose that switch to the person. Never make it.** The strategy envelope is what they approved, and a mechanism that quietly left it would make the envelope unauditable. Show them the line and the tuple it would change, and when they agree:

```text
promptobus models strategy --set <name>
```

That records `defaults.strategy` in the host's writable overlay, and every following `spawn` and `review` without `--strategy` routes with it — the proposal holds without repeating a flag. `promptobus models strategy` alone prints the effective default and the layer it came from; `--clear` removes it. A `--strategy` on the command line always wins over the recorded default, so a track whose envelope names its own strategy is unaffected.

This is the only thing that changes a strategy between spawns, and a person is on both ends of it.

### When the local runs disagree with the catalog

The catalog's ratings come from published benchmarks. `promptobus models calibrate` reads this machine's own telemetry back against them and prints, per harness/model/effort, how many runs it has, the median time to a finished piece, the median movement of the account's limit windows, and — where a key has at least five runs — a proposed `speed` and `quotaCost` line for the user overlay with the catalog band beside it and the numbers behind it.

**Read it as evidence, not as a verdict.** The key with the most runs is the anchor and keeps its catalog band; every other key is proposed a step away from ITS OWN band, at most two, and only when the measurement differs materially from what the bands already imply. A line reading `insufficient data: N of 5` is the command declining to guess, and `quality` is never proposed at all — review rounds measure how work was received, not how good a model is.

Run it when a person asks why a model was picked and their experience disagrees, or after a long series on one harness. Then show them the proposal and let them decide:

```text
promptobus models calibrate
promptobus models calibrate --write
```

`--write` merges only the proposed `ratings` into the person's `user` overlay, keeps every other key of that file, and **asks on the terminal first**. Do not pass `--yes` on their behalf: it exists to record an agreement the person already gave, and using it to skip the question is the one thing the flag is not for. As with a strategy switch, a person is on both ends of this.

### The one question the tool cannot answer

`models` prints the key and the file when nothing has recorded Cursor's plan name, because no Cursor method returns it. **Ask the person once, and only once**, and only when a run will actually use Cursor. The line goes in the `user` overlay, `~/.promptobus/model-routing.json`:

```json
"account": { "cursor": { "plan": "<the plan name>" } }
```

No command writes it: the writable layer is per-workspace, so a tool-written answer would be asked again in the next workspace. The value is display only and enters no score, so a run is not blocked while it is missing — do not stall a spawn on it, and do not ask a second time in the same run.

### The strategy envelope

Agree the envelope with the user before the first spawn, in the same approval as the split. It names three things:

- the strategy of each track;
- the harnesses the run may use;
- whether pay-as-you-go is allowed (`--allow-payg`).

A fallback **inside** the envelope needs no second approval: a preflight that excludes the first candidate moves to the next one on an allowed harness, and the user already approved that. **Leaving** the envelope does need one — another harness, pay-as-you-go they did not allow, a strategy other than the one agreed for that track. Ask; do not widen it yourself.

`promptobus models [--strategy <s>] [--role <worker|reviewer>]` is how you see what a strategy would pick before spawning. Show it when you propose the envelope. It reads the availability cache; `--refresh` probes the harnesses instead. On `spawn` and `review`, `--dry-run` reads the cache and starts nothing.

`promptobus status` prints the strategy, tuple, snapshot age and warnings of every routed participant. Audit the envelope there during the run, not only at its start. A lift routed by the recorded default rather than by a flag says so, so a run made under a switch the person agreed to is auditable as one.

### Refresh right before you close

`promptobus done` writes one local telemetry record per participant, and the window readings in it are the ones the availability cache holds at that moment. `done` probes nothing, and a window entry lives sixty seconds. So run

```bash
promptobus models --refresh
promptobus done --task <id>
```

**in that order, back to back.** Without the refresh the record carries the spawn reading only and no end value, and what the run actually spent on each account is unmeasurable afterwards — the file is append-only and there is no second chance at the close. The record is local, holds no prompt, path, session id or token, and nothing sends it anywhere.

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
