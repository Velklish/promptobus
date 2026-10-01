---
name: orchestrate
description: Orchestrate a large task with worker sessions on Promptobus. Use when work splits across repositories or independent slices, and the user asks to spawn workers, run in parallel, or watch a worker. Start workers only after explicit approval. Not for a one-line edit, a read, or a question. Isolated review of one diff without workers is solo-review.
---

<!-- promptobus:owned -->

# Orchestrate

You hold the whole task. Workers edit isolated git worktrees. Mail goes through Promptobus. Workers do not write to each other.

This installed skill carries the workflow and commands needed offline. Its versioned links add reference detail; the solo-review skill is installed beside it.

A small change is not an orchestration. Do the work yourself.

Launch workers only after the user says yes to a named split. Silence is not approval.

## Roles

| Role | Who | Does | Does not |
|---|---|---|---|
| Orchestrator (TGM on a root task) | you | Cut the work, write briefs, spawn, accept results; hold contracts between groups on a root task | Edit a worker's tree or confirm a finding closed |
| Teamlead | one session with `teamlead:<slug>` in the root and `orchestrator` in its child task | Run one group's workers and delivery pipeline; report upward | Decide a change of logic or requirements for the root |
| Worker | a session in a worktree | Change that tree, send `status` / `question` / `result` | Decide for you, open tracker files, talk to the user |
| Reviewer | `promptobus review` | Read every diff of a piece, send findings, confirm their closure on its next pass; a replacement for a dead reviewer starts from a clean slate | Fix the findings |
| Reporter | optional read-only session on a root task | Answer the person from the task journals | Send as `reporter` or treat a result as accepted |

## Choosing a flat task or a tree

The owner measured 33 task journals on this machine on 2026-09-26. The median task had 3 pieces, 3 concurrent workers, 69 messages to the orchestrator and took 1.1 hours. The five largest had 5 to 33 pieces, peak concurrency of 3 to 7 workers, 400 to 832 messages to the orchestrator, 344 to 877 thousand characters of inbound mail and lasted up to 16.8 hours. Use the owner's thresholds from that measurement:

- Keep one orchestrator for up to 5 pieces and up to 3 concurrent workers, in one repository group with one acceptance recipe, when the run is expected to take up to 8 hours.
- Raise a root task with a TGM and child tasks led by teamleads from 8 pieces, from 4 concurrent workers, for two or more repository groups with different acceptance recipes, or whenever a contract between groups needs someone above both to hold it. Any one condition is enough.
- For 6 or 7 pieces, let the task owner choose the shape. Ask the owner to choose when the expected run exceeds 8 hours without another tree trigger.

The TGM holds the whole task and gives each teamlead a brief for its repository group. Each teamlead owns one child task and its workers. The tree has only these two levels. Keep each group's assignments, results and review inside its child task; summarize progress and decisions to the root.

## Teamleads and siblings

Sibling teamleads under the same root may settle small coordination directly with `question`, `answer`, `status` or `artifact`. The bus refuses `task`, `result` and `review` between siblings. Raise a change of logic, a change of requirements, or a question the brief and rules do not answer to the root orchestrator without waiting to be asked. A teamlead reads its rule files before work and lists every rule file it read by path in its first `status` to the root.

## Reporter for the person

When a reporter is present on a root task, it reads the whole tree's journals through `promptobus_digest`, live session state through `promptobus_status`, and task metadata through `promptobus_task`. It answers the person in its own window from those records, names the message behind its answer, and never paraphrases a participant's `result` as accepted. If the records do not answer, it calls `promptobus_ask { body, task: <root> }` on the person's behalf as `user`, then reads later answers with `promptobus_ask { answers: true, after: <question id>, task: <root> }` and brings the orchestrator's answer back with its message id. A pending answer stays pending. The terminal `promptobus ask` refuses a participant identity; the reporter uses its restricted MCP tool. It never sends as `reporter`, writes files, runs builds or tests, or forwards or filters worker status for the orchestrator. Claude Code denies Bash as a tool. Codex reviewers disable shell execution tools and read local files through the bounded reviewer_files MCP tools; its reporters keep a read-only filesystem sandbox with native shell reads available. Both roles forbid builds and tests.

## Tools

MCP server name: `promptobus`. Participant tools: `promptobus_send`, `promptobus_mailbox`, `promptobus_task`. A proven reporter session alone can also call `promptobus_digest`, `promptobus_status`, and `promptobus_ask`; `promptobus_send` remains denied in its lift and refused by routing.

```
promptobus_send { to, type, body, artifactPath?, task? }
promptobus_mailbox { claim?, message?, task? }
promptobus_task { task? }
promptobus_digest { task? }
promptobus_status { task? }
promptobus_ask { body?, answers?, after?, task? }
```

`to` names an address registered in that task. The shipped delivery steps are `worker:<slug>`, `reviewer:<slug>` and `approver:<slug>`; governance routes also admit registered teamleads, linked peers and `user` under their message-type rules. The reporter has no send route.

Types: `task`, `status`, `question`, `answer`, `artifact`, `result`, `review`.

`promptobus_mailbox` returns headers, not bodies: type, sender, time, message id, size and first line. That read marks the mail read. `promptobus_mailbox { message: <id> }` returns one body and marks nothing. `claim` and `message` do not go together.

Without `task`, the server uses `PROMPTOBUS_TASK`, else this session's binding, else the only active task. If the reply names another title, you joined the wrong task. Pass `task`.

A foreign-mailbox header names both session ids and means the originals stay with the owner. If the mail is yours and this session is new, `promptobus_mailbox { claim: true }`; the reply `MAILBOX CLAIMED` names the previous owner. Then read again without `claim`. A task an earlier CLI created has no owner and nothing to claim (`src/mcp/server.ts`).

A session has one live binding: the active task its calls use without `task`. `spawn` and `review --approver` write it for the task's owner, `review` only when it joins an existing task, and `claim` rewrites it (`lib/store.js`).

`promptobus_send` refuses a non-participant address, listing the participants, an `artifact` without `artifactPath`, and an undeclared key (`lib/store.js`, `src/mcp/server.ts`). `promptobus_task` returns the task's id, title, status, parent, children, pipeline, artifacts directory and your unread count, and per participant its owner, repository, worktree, git branch, session, diff snapshot and unread count (`lib/server.js`, `src/mcp/render.ts`).

A participant's prompt spells the bus tools per harness: `promptobus_send` on Claude Code, `promptobus-promptobus_send` on Cursor, `mcp__<command>_promptobus__promptobus_send` on Codex, with characters of `<command>` other than letters, digits and `_` turned into `_` (`lib/driver-claude.js`, `lib/driver-cursor.js`, `lib/driver-codex.js`).

## CLI

```bash
promptobus lead --brief <file> [--task <new-id>] [--title <name>] [--model <m>] [--effort <e>] [--permission-mode <p>] [--strategy <s>] [--dry-run]
promptobus lead --resume --task <active-id> [--brief <continuation>] [--dry-run]
promptobus report --task <root> [--harness claude|codex] [--model <m>] [--effort <e>] [--strategy <s>] [--dry-run]
promptobus ask --task <root> "<question>"
promptobus ask --answers --task <root>
promptobus spawn --repo <path> --brief <file> [--task <id> | --new-task] [--title <slice>] [--task-title <task>] [--slug <s>] [--worker <name>] [--model <m>] [--effort <e>] [--permission-mode <p>] [--harness <h>] [--strategy <s>] [--allow-payg] [--refresh] [--dry-run]
promptobus spawn --teamlead --brief <file> --task <root> [--slug <s>] [--strategy <s>] [--model <m>] [--effort <e>] [--harness claude|codex] [--permission-mode <p>] [--allow-payg] [--refresh] [--dry-run]
promptobus status [--task <id>]
promptobus done [--task <id>] [--keep-sessions]
promptobus stop <address> [--task <id>]
promptobus sweep <address> [--task <id>]
promptobus dismiss <address> [--task <id>]
promptobus prune [--older-than <days>] [--yes]
promptobus warden [--task <id>]
promptobus review <path> [--task <id> | --title <name>] [--base <ref>] [--model <m>] [--effort <e>] [--permission-mode <p>] [--harness <h>] [--strategy <s>] [--allow-payg] [--refresh] [--approver [--brief <file>]] [--dry-run]
promptobus models [--strategy <s>] [--role <worker|reviewer|approver>] [--refresh] [--json]
promptobus lease [--as <address>] [--task <id>] [--wait <seconds>] -- <command…>
```

`--harness` must be listed in `promptobus.json` `tools`. For a new ordinary `spawn` or `review` without the flag, an explicit or recorded strategy can select a harness from that list. With no strategy, the new unrouted lift falls back to `claude`. A repeat `spawn` uses its participant's recorded harness; a repeat `review` uses the reviewer's recorded harness unless an allowed explicit harness rebind takes effect. A teamlead lifts on Claude Code or Codex; Cursor is refused. With no `--harness`, no Codex-only `--model` and no strategy, a new teamlead lifts on Claude Code; a relift keeps its harness. A reporter lifts on Claude Code or Codex; name `--harness codex` for a Codex-only workspace. Its Codex private home disables project hooks and bus send, without writing the shared root.

For a tree, the root orchestrator lifts a teamlead with `spawn --teamlead`. Its child task is the default in the lifted session's MCP entry; the teamlead reports upward by naming the root task explicitly. The teamlead runs at the install root on Claude Code or Codex. Give a Codex teamlead `--permission-mode full-access`: it is the narrowest profile under which its own workers and reviewers lifted in the measured proof. `--dry-run` shows the child task and session plan before starting it.

`--strategy` is one of `quality`, `balanced`, `speed`, `economy`, `balance`. Without it the command takes the recorded default if there is one, and otherwise routes nothing and takes the defaults. See [Model routing](#model-routing).

`--repo` is a path on disk. `spawn`'s `--brief` is required. `review --approver` takes `--brief <file>` for the approver's assignment: the lift prompt carries it, and after the lift the bus keeps `brief-approver-<slug>.md` in the task files, beside the worker's `brief-<slug>.md` rather than under that name. Do not send that assignment as a separate message for the approver to race its first turn. A later message to the approver stays legal. `--brief` without `--approver` is refused, because a reviewer's subject is the diff.

Read the worker's worktree path and branch from `promptobus status` or `promptobus_task`. Do not rebuild them from a name template. The worker may have switched branches: the line then says `WORKER CHANGED BRANCH` (`lib/worktree.js`). Publish the branch git reports.

Lead a new Codex root with `promptobus lead --brief <file> --permission-mode full-access`. The full-access profile is explicit because orchestration launches workers and reviewers; the ordinary default is workspace-write. The managed holder binds the complete native thread as the root owner before its first model turn, then receives warden postcards. Worker, reviewer, teamlead and approver commands use that root task id. The person can inspect `status` and ask through `ask`; `done` stops the managed root too. `lead` refuses an existing task rather than taking over its mailbox.

An active managed Codex root whose holder and app-server are both dead can continue with `lead --resume --task <id>`. It must retain its recorded private home and native thread; resume uses `thread/resume`, preserves the owner and journal, and refuses a closed task, an attached Desktop session, a mismatched thread or a live launcher. Normal `stop` and `done` retire the private home, so they are not a pause-and-resume mechanism. A bound root whose first model turn fails retains its record and history for recovery. Subscription access snapshots expire: sign in through the ordinary owner login before relaunching; participants never refresh the owner's credentials.

A root already owned by a Claude Code session continues to use its messaging socket. `lead` does not convert an arbitrary Desktop chat into a managed owner. A teamlead lift records its own harness and native session as the child task owner, so Codex can lead both roots and children.

Names: task id `<task-slug>-t<YYYYMMDD>-<HHMMSS>` (UTC), slug from `--slug` or the task title; worker slug `--worker`, else the repository directory, numbered `-2`, `-3` when another repository already holds it; worktree `<clone>/.claude/worktrees/promptobus-<task-slug>-<worker-slug>-t<date>-<time>` on branch `worktree-<that name>`; session `Worker: <slice title> (<MMDD-HHMM>)`, or `Review:` and `Accept:`, with the slug added on a name collision; Cursor names its own persist session (`lib/spawn.js`, `src/protocol.ts`).

`--title` names the slice and its session, and defaults to the brief's first line. `--task-title` names and pins the task; without it the task title joins the slice titles with ` · ` (`lib/spawn.js`).

Without `--task`, `spawn` joins the bound task, else the only active one, else creates one, and refuses to join a task another session owns. A second `spawn` into one repository without `--worker` reuses the first worker's address: it restarts a dead session and refuses a live one (`lib/spawn.js`).

`--effort` and `--permission-mode` are checked against the chosen harness before any write; a `--model` of another harness is refused by its binary only after the task and worktree exist; `spawn --teamlead` refuses a catalog-rated model with no tuple on the named `--harness` before any write (`lib/spawn.js`, 03-cli § An explicit model the catalog does not rate).

`status` prints the warden line, `warden: alive` or `NO WARDEN`, and only reads; the next `spawn`, `review`, `send`, bus tool call or turn end starts a missing warden (`lib/status.js`, `lib/warden.js`).

`stop <address>` closes one participant's session and retires the harness's record of it; the task, the participant and its mailbox stay. `sweep <address>` removes one accepted piece's worktree, branch and sent artifacts once its session is dead and its merge is proven. `dismiss <address>` only stops watching. The task mailbox owner or an approver of this task in its own recorded session may call these; `done` is the owner's alone ([03-cli § Status, done, sweep](https://github.com/Velklish/promptobus/blob/v0.21.0/docs/reference/03-cli.md#status-done-sweep-dismiss-history-prune)).

`done` closes the task, stops the sessions the bus started unless `--keep-sessions`, removes the worktree and `worktree-` branch of each closed task whose session is dead and whose work is proven merged, and last removes journals of tasks closed over 14 days ago; `prune` without `--yes` only previews (`lib/done.js`, `lib/prune.js`).

`review <path>` without `--task` picks up the single active task that records the path. The diff base is `--base`. Otherwise, in a worker worktree, it is the merge base with the local default branch, except that the recorded branch point is used when the worker branch is already merged or the default branch was rewritten, and the repository default branch when neither exists; in the main clone it is the repository default branch. The command prints it (`lib/review.js`). A repeat `review` sends the new diff to the live reviewer: `--strategy` is ignored, and another `--harness` is refused until `promptobus stop <address>`.

A `review` that opened a task and failed to start its reviewer leaves an active orphan that no call without `--task` picks up, and prints `promptobus done --task <id>`. A failed `spawn` keeps its task and record for a repeat of the same command (`lib/review.js`, `lib/spawn.js`).

A Codex holder declines an MCP server's own elicitation with `{ action: "decline" }` and accepts Codex's per-call tool approval for a server in the participant's home ([03-cli § The Codex holder](https://github.com/Velklish/promptobus/blob/v0.21.0/docs/reference/03-cli.md#the-codex-holder)).

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

Role quality floors are soft; on the ten-point scale they default to worker 5, approver 7, reviewer 9; a pick below one carries `<role>-floor-not-met` (`src/registry.ts`). The shipped catalog rates no Anthropic model on Cursor (`models/catalog.json`).

`balance` is not a row of the quality ladder and does not move with the price of a mistake: it answers which ACCOUNT to spend from, and orders tuples inside a harness by `balanced`. It is the strategy for a person paying several subscriptions who wants the work spread over all of them instead of exhausting one — reach for it when `models` says an account is running short, or when the run is long enough that the spend matters, not as a general default. The reviewer is inside it like a worker: **nothing in this package pins the reviewer to a harness** ([solo-review](../solo-review/SKILL.md) § Reviewer strategy).

Each live participant of the task on a harness costs its tuples 5 score points by default (`penalties.liveParticipantPerHarness`), at most 20 (`penalties.liveParticipantCap`), under every strategy. `balance` chooses the harness by pace, so the penalty only orders the tied band; under `balance` alone, `caps.liveParticipants.<harness>` is the ceiling (03-cli § `balance`: which account to spend from).

### When `models` says an account is running short

A `near-limit` line in `promptobus models` names a harness whose limit window is at or past its level threshold, or which is spending faster than the window refills past its rate threshold, and it names the strategy it would switch to — `economy` when every paced harness is short by either test, `balance` when at least one paced harness is not short.

A `window-nearly-spent` row means that harness left automatic selection at 90 % or more of its binding window used; it returns once a `--refresh` shows the window refilled, or when the person names it with `--harness` or `--model`. A `candidates-empty` refusal carrying that detail means every account is past the threshold, and whether to name one and spend it is the person's decision, not yours.

**Propose that switch to the person. Never make it.** The strategy envelope is what they approved, and a mechanism that quietly left it would make the envelope unauditable. Show them the line and the tuple it would change, and when they agree:

```text
promptobus models strategy --set <name>
```

That records `defaults.strategy` in the host's writable overlay, and every following `spawn` and `review` without `--strategy` routes with it — the proposal holds without repeating a flag. `promptobus models strategy` alone prints the effective default and the layer it came from; `--clear` removes it. A `--strategy` on the command line always wins over the recorded default, so a track whose envelope names its own strategy is unaffected.

This is the only thing that changes a strategy between spawns, and a person is on both ends of it.

### When the local runs disagree with the catalog

The catalog's ratings come from published benchmarks. `promptobus models calibrate` reads this machine's own telemetry back against them and prints, per harness/model/effort, how many runs it has, completion-duration evidence, usable throughput, the median movement of the account's limit windows, and — where evidence reaches the threshold — proposed `speed` and `quotaCost` lines for the user overlay with the catalog band beside them and the numbers behind them. Speed observations pool across every effort rung of a `(harness, model)` and produce one speed band for that ladder; completion duration is never a speed input.

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

`promptobus models [--strategy <s>] [--role <worker|reviewer|approver>]` is how you see what a strategy would pick before spawning. Show it when you propose the envelope. It reads the availability cache; `--refresh` probes the harnesses instead. On `spawn` and `review`, `--dry-run` reads the cache and starts nothing.

`promptobus status` prints the strategy, tuple, snapshot age and warnings of every routed participant. Audit the envelope there during the run, not only at its start. A lift routed by the recorded default rather than by a flag says so, so a run made under a switch the person agreed to is auditable as one.

### Close-time telemetry refresh

`promptobus done` writes one local telemetry record per participant and automatically refreshes the availability of exactly the window-bearing harnesses represented by those records. It uses the existing 15 s preflight budget for that probe set, so there is no separate `promptobus models --refresh` step to remember. A window entry still lives sixty seconds, and a probe refusal or timeout leaves that harness's end reading `null`; `done` warns with `telemetry: <harness> window <id> not re-read (<reason>) — end reading absent` for a missing window (or the harness-level form when the whole harness is unavailable) and still closes the task. The record is local, holds no prompt, path, session id or token contents, and may carry a numeric output-token count as throughput evidence; nothing sends it anywhere.

### Constraints the user named

An explicit `--harness`, `--model` or `--effort` from the user travels to the CLI unweakened. **Never rewrite a named model into a strategy**, and never pass a strategy as its alternative: a named value is a constraint the resolver applies, and the CLI ends with diagnostics rather than substituting when it cannot be met. Report those diagnostics to the user; do not pick something else for them. A named model the catalog does not rate is not routed: the lift runs that id as typed under the policy in force, on `--harness` or else on Claude Code, and warns that the strategy routed nothing. Name `--harness` with it when it is not a Claude Code model.

### Step up after two rounds

`promptobus status` prints the review-round count on each participant line. When it reaches two, inspect the rounds for progress: two review rounds on one worker with no progress — the same findings return, or a fix breaks what it fixed — mean the model is under the task. A finding you filed, or the user ruled out, and named to the reviewer is not a returning one. Step up once, and only once, without asking again if it stays inside the envelope:

1. the next strategy up the rubric, or
2. an explicit `--harness` / `--model` / `--effort` tuple you name.

Re-spawn that track. Name the step-up and its reason in the run's result: a run that quietly cost more than its envelope is not auditable.

A consumer layers its own policy on top of this rubric — which models it forbids, where its reviewer runs. That belongs in the consumer's own skills, not here.

Flags, reason codes and error codes: [reference/03-cli.md](https://github.com/Velklish/promptobus/blob/v0.21.0/docs/reference/03-cli.md) § Model routing. The catalog and overlays: [guides/model-routing.md](https://github.com/Velklish/promptobus/blob/v0.21.0/docs/guides/model-routing.md).

## Mail

Do not wait on the bus. The warden knocks when mail arrives. A knock names each message's type, sender and size and never carries its text. Only `promptobus_mailbox` marks mail read. Call it, then ask the bodies you need by id.

A lost knock loses nothing. The mail stays in the mailbox.

`PROMPTOBUS_WARDEN=off` disables the warden. Then participants must poll `promptobus_mailbox`.

Each driver declares one activation, `push` (the warden knocks) or `pull` (the participant polls); all three shipped drivers push (`src/driver.ts`). A knock during a turn is queued for the next turn, not steered into the running one (`activate` in `lib/driver-*.js`). A repeat knock previews only messages that arrived after the previous knock; the first knock, and the first after the session behind the contact point changed, carry the whole list. A contact point held by a session other than the address's own gets no knock, and `status` shows self-wake (`src/supervisor.ts`).

`self-wake — starting up; clears on the first knock` in `status`, the orchestrator's line included, means no contact point was handed over yet, not a broken channel (`lib/status.js`).

A Claude Code session in `bypassPermissions` without `"crossSessionInbound": "accept"` holds a postcard as a dialog; the lift writes that key for such a participant (`lib/driver-claude.js`).

The Stop guard (`promptobus guard`) returns the turn when the mailbox is unread. Same unread set twice, then it warns and lets the turn end. Empty the mailbox. Do not remove the hook.

## Worker protocol

A worker's first bus message is `status`: what it read, what it will do. Further `status` on every visible step. Background work longer than a couple of minutes is announced with volume and a measured estimate before the worker goes quiet.

The spawn preamble reports repository dependency state. On a fresh worktree, the repository generator runs before dependency installation, and dependency installation runs before launch files are written; the launch files are written once with both outcomes. The preamble says when installation succeeded and need not be repeated, when it refused and which command to run by hand, or when there is no lock to install. A repeat spawn does not rerun or check dependencies in the surviving worktree, so the worker must look before relying on them. If installation is interrupted, the worktree can temporarily have its journal record but no launch files; a repeat spawn rewrites the launch files without checking dependencies.

A worker that cannot continue sends `question` and ends the turn. You answer with `answer`. Do not guess for the user.

Before `result` the worker sends the gate record `gates-<slug>.json` and the handover record `handover-<slug>.json` as `artifact` messages; `send` refuses one that fails its schema and names the faults ([04-protocol § The gate record](https://github.com/Velklish/promptobus/blob/v0.21.0/docs/reference/04-protocol.md#the-gate-record)).

When the worker is done it takes mailbox, then sends `result` (what changed, gates as numbers, what is still open). Check its gate and handover records, then run `promptobus review` on its worktree. The reviewer's findings come to you: validate each — keep it for the worker this round, file it in the tracker, or take a fork to the user — and send the kept ones to the worker as `review`. You do not reject a finding yourself: a dispute over one goes to the user. The worker fixes and sends `result` again; check the records of the fix, tell the reviewer in a `status` message which findings you filed (with their ids) and which ones the user ruled out, and run the same `review` again. The loop ends when the reviewer returns a pass with no new finding and no kept one still open, never on your own reading of the diff, however small ([solo-review](../solo-review/SKILL.md) § Collect the report); only then lift the approver. Keep the reviewer alive until the piece is accepted: the same session reads every new version with its earlier findings in mind.

You do not merge the worker branch until you accept the result. The worker does not push and does not edit the main tree.

## Machine lease

Participants share the machine, and runs of other tasks and workspaces load it too. The bus keeps one machine lease: `promptobus lease -- <command…>` holds it for the length of one measuring run, a waiter names the lease holder and gives up at a bound, and a lease holder that dies releases it by liveness. `promptobus status` names the lease holder, since when, and the waiters.

It replaces orchestrator-issued slots. Do not hand out "the test slot" and do not teach a lock in the brief: the worker and approver preambles already carry the command, addressed, and the rule for what is a measurement — the repository's full test suite and its gate command. How many participants run at once is still yours to decide.

## Stops

`promptobus status` prints a stopped participant with a reason and a driver route. Follow that route. Do not invent a attach/stop command for a harness you have not read. `status`, `spawn`, `review`, `done` and `stop` fill the harness's own commands, such as `claude attach <id>`, into their routes from its driver (`lib/driver-claude.js`).

A stall goes to the warden journal once per sighting, to `status` and to the orchestrator's `promptobus_mailbox` reply, with no postcard; a refusal naming a reset sends the orchestrator one `unreachable` postcard and holds knocks to that participant until the named reset (`src/supervisor.ts`, `lib/server.js`).

A line that says the process is gone is not a stop. Recover a retained dead managed Codex root with `promptobus lead --resume --task <id>`. Re-spawn other roles: `promptobus spawn` for `worker:<slug>`, `promptobus review <path> --task <id>` for `reviewer:<slug>`, `promptobus review <path> --task <id> --approver` for `approver:<slug>` after the reviewer has sent a result. Spawn cannot create a reviewer or approver address.

A participant who sent you mail and then ended the turn is waiting, not stopped.

## Not this skill

- One diff, no workers: [solo-review](../solo-review/SKILL.md)
- Contribution tracker: [docs/guides/contributing.md](https://github.com/Velklish/promptobus/blob/v0.21.0/docs/guides/contributing.md)
