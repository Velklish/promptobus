# CLI

Parser: `lib/cli.js`. Commands: `spawn`, `review`, `status`, `done`, `dismiss`, `history`, `prune`, `guard`, `warden`, `mcp`. The [Model routing](#model-routing) section below is the one part of this file that describes a surface the running version does not have yet.

Help and `--version` do not load the standalone host. Every other command does.

## Spawn

Required: `--repo`, `--brief`. `--brief` is a file (`lib/spawn.js`). The file itself is the orchestrator's and temporary: after a successful lift the bus keeps its own copy in the task files folder as `brief-<worker>.md`, next to the review diffs, and names the path in the lift output. Every lift stores the brief it was given: a repeat at the same address takes the next number (`brief-<worker>-2.md`) and never overwrites the previous one. A refused spawn keeps nothing, and `--dry-run` does not predict the path: it writes nothing, and which number a name takes is the race's to decide at the write.

`--harness` must be in `host.declaredTools()` when present. Without the flag the registry fallback is `claude` (`lib/drivers.js`). Unknown harness names fail before any disk write.

`--new-task` and `--task` conflict. Without `--task`, spawn joins the only active task, or opens a new one when several actives exist and this session has no binding. A task owned by another session refuses a silent join.

`--title` names the worker slice. `--task-title` names the task on create. `--dry-run` prints the plan.

The worker gets an isolated git worktree. The main tree is not edited. Read the branch from `promptobus status` or `promptobus_task`, not from the worktree name.

## Review

The path is required. There is no cwd resolve. `--title` is required to open a new review task. `--task` sends a new diff to the existing reviewer. `--base` sets the diff base. `--dry-run` prints the plan.

The reviewer is read-only. A harness that cannot deny tools must fail before spawn (`src/driver.ts` `denyTools`).

## Model routing

**Not implemented yet.** This section is the contract [ADR-003](../adr/adr-003-model-routing.md) fixed and PB-13…PB-21 implement against; the running version has no `models` command and no `--strategy` flag, and `--help` does not name them. It is written here first so that the shapes, the flags and the codes are decided once instead of nine times, and so the golden fixtures in `test/fixtures/model-routing/` have something to be golden against.

### Commands

```text
promptobus models [--strategy <quality|balanced|speed|economy>] [--role <worker|reviewer>] [--refresh] [--json]
promptobus models validate
promptobus models --clear-exhausted <harness>
promptobus spawn  … [--strategy <quality|balanced|speed|economy>] [--allow-payg]
promptobus review … [--strategy <quality|balanced|speed|economy>] [--allow-payg]
```

`models` prints what the resolver would pick right now: the chosen tuple, every candidate it considered with its score components, the models the account exposes that the catalog does not rate, and the warnings. `--role` defaults to `worker`. `--refresh` ignores live cache entries and probes again; under `--dry-run` it is the only thing that makes a probe run at all. `--json` prints the decision document; its shape is `schemas/model-routing/decision.schema.json` and it is pinned byte-for-byte by `test/fixtures/model-routing/decision.json`. The text output is pinned the same way by `models.txt` next to it: candidates are printed in the order the decision document lists them — scored first by descending total, then excluded ones by canonical priority.

`models validate` checks the catalog and every overlay: schema, references to tuple, model and harness, rating ranges, weight sums, duplicate ids, and rules that both allow and deny the same name.

`models --clear-exhausted <harness>` drops an exhaustion the cache is holding with no known reset. Nothing else clears one: an exhaustion with a reset expires by itself.

`--strategy` on `spawn` and `review` hands the resolver an intent. `auto` is not a value here — the orchestrating agent turns a task into one concrete strategy before the call. Without `--strategy` the command takes today's path exactly, with today's defaults.

`--allow-payg` admits pay-as-you-go tuples, which are otherwise excluded from automatic selection.

`--harness`, `--model` and `--effort` remain **constraints, not wishes**: a named value is never replaced. If the named combination is unavailable or exhausted, the command ends with diagnostics.

`--dry-run` **reads the cache and nothing else**: no probe, no binary started, no network, and no write. A probe happens only when `--refresh` asks for it, and `--refresh --dry-run` probes but still writes neither a cache entry nor task state. A snapshot that is stale or absent under `--dry-run` is reported in the decision — `stale_cache` on the harness, plus a `snapshot-stale` warning — never silently taken as fact. A dry run is how a person asks a question; a question that starts three harness binaries and waits fifteen seconds is not one, so the flag that costs time is the one that says so.

### Reason codes

The state of one harness in the availability snapshot, with its reason. `snake_case`, quoted verbatim from ADR-003 — the snapshot vocabulary keeps the spelling the decision fixed, while package error codes below follow the `kebab-case` of `ERROR_CODES` (`src/v1/errors.ts`).

| Code | State it accompanies | Meaning |
|---|---|---|
| `binary_missing` | `unavailable` | The host's `resolveToolBin` found no binary for that harness |
| `not_authenticated` | `unavailable` | The binary is there, the account is not logged in |
| `model_not_available` | `unavailable` | The account does not expose the model an explicit `--model` named. **Only that path**: this state is the harness's, so setting it for a model would drop every tuple of that harness. The per-tuple fact is the `model-not-in-inventory` exclusion below |
| `subscription_exhausted` | `exhausted` | The limit is confirmably spent; `resetAt` when the harness gives one |
| `probe_timeout` | `unknown` | The adapter did not answer inside the 15 s preflight budget |
| `probe_failed` | `unknown` | The adapter answered with an error that is not one of the above |
| `quota_unknown` | `unknown` | Auth is fine; this harness exposes no stable source for the remaining limit |
| `stale_cache` | `unknown` | The cache entry is absent or outlived its TTL and no probe ran — `--dry-run` without `--refresh`, or the preflight budget was spent |
| `manual_exhaustion` | `exhausted` | A person marked the harness exhausted; cleared only by `--clear-exhausted` |

### Exclusion, adjustment and warning codes

Why a candidate did not reach scoring, what moved its score, and what the person is told. `schemas/model-routing/decision.schema.json` carries the same three enums; this table is the prose half.

| Kind | Code | Meaning |
|---|---|---|
| exclusion | `model-not-in-inventory` | The catalog rates the tuple; the account does not expose that model |
| exclusion | `role-not-allowed` | The tuple is not rated for the role being routed |
| exclusion | `constraint-mismatch` | An explicit `--harness`, `--model` or `--effort` rules it out |
| exclusion | `denied-by-policy` | An allow/deny rule of an overlay; `detail` names the layer |
| exclusion | `payg-not-allowed` | Pay-as-you-go without `--allow-payg` |
| exclusion | `harness-unavailable` | The harness snapshot is `unavailable` |
| exclusion | `harness-exhausted` | The harness snapshot is `exhausted` |
| adjustment | `unknown-availability` | −10: the remaining limit is unknown, counted as a neutral 50 % |
| adjustment | `live-participant` | −5 per participant already live on that harness, capped at −20 |
| adjustment | `reviewer-diversity` | +5: this reviewer's harness or model differs from the worker's |
| warning | `stale-rating` | A tuple's `assessedAt` is old. A warning only — never an exclusion |
| warning | `unknown-remaining` | At least one harness could not report its remaining limit |
| warning | `reviewer-floor-not-met` | No reviewer candidate reached the quality floor; the best remaining one was taken |
| warning | `snapshot-stale` | The decision was made on cache entries past their TTL |
| warning | `probe-incomplete` | An adapter missed the preflight budget and its harness is `unknown` |

### Error codes

Routing failures end the command. Every one of them happens **before any write**: no task, worktree or participant exists when they fire — except `limit-hit-at-start`, which is the one case where the store is already written and the command says so.

They are `PromptobusError` codes, and PB-21 registers them in `ERROR_CODES` (`src/v1/errors.ts`) together with the implementation — which is why they are `kebab-case` while the snapshot's reason codes above keep the `snake_case` the decision fixed. Registering them now would put nine codes in the public list that nothing can raise; once PB-21 lands, the existing drift check covers them and this table stops being the only place they live.

| Code | When |
|---|---|
| `strategy-unknown` | `--strategy` is not one of the four values |
| `role-unknown` | `--role` is not `worker` or `reviewer` |
| `harness-unknown` | `--clear-exhausted` names a harness the workspace does not declare |
| `catalog-invalid` | The shipped catalog fails schema or reference validation |
| `overlay-invalid` | An overlay fails schema, reference or contradiction validation; the message names the layer |
| `constraint-unknown` | An explicit `--harness`, `--model` or `--effort` matches no tuple in the merged catalog |
| `constraint-unavailable` | The explicitly named tuple exists but its harness is `unavailable` or `exhausted` |
| `candidates-empty` | Nothing survived filtering. The decision document is still printed, with `chosen: null` |
| `limit-hit-at-start` | The limit was hit between preflight and start. The cache is marked exhausted; the command does not retry |

### Files

| What | Where | Notes |
|---|---|---|
| catalog | shipped with the package | `schemas/model-routing/catalog.schema.json` |
| overlays | `host.routingPaths().overlays`, lowest precedence first | standalone: `user`, then `workspace` ([02-host](02-host.md)) |
| availability cache | `host.routingPaths().cacheFile` | mode `0600`; no prompt, token, email or open account id |

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
