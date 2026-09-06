# CLI

Parser: `lib/cli.js`. Commands: `spawn`, `review`, `models`, `status`, `done`, `dismiss`, `history`, `prune`, `guard`, `warden`, `mcp`, `install`, `uninstall`. That list is the whole vocabulary: a message that names anything else names a command nobody can run. `test/cli.test.mjs` reads the dispatcher's own `case` labels and fails on any `formatCommand`, `busCommand` or `formatNpx` call under `lib/` whose command is a string literal outside them. A hint a host assembles by template is not checked — the package cannot read it.

Help and `--version` do not load the standalone host. Every other command does.

## Spawn

Required: `--repo`, `--brief`. `--brief` is a file (`lib/spawn.js`). The file itself is the orchestrator's and temporary: after a successful lift the bus keeps its own copy in the task files folder as `brief-<worker>.md`, next to the review diffs, and names the path in the lift output. Every lift stores the brief it was given: a repeat at the same address takes the next number (`brief-<worker>-2.md`) and never overwrites the previous one. A refused spawn keeps nothing, and `--dry-run` does not predict the path: it writes nothing, and which number a name takes is the race's to decide at the write.

`--harness` must be in `host.declaredTools()` when present. Without the flag the registry fallback is `claude` (`lib/drivers.js`). Unknown harness names fail before any disk write.

Declaring a harness is a hand edit of the tool manifest — under the standalone host, the `tools` array in `promptobus.json` — and the refusal for an undeclared one names that file and that field. There is no `tools` subcommand; the only command the refusal prints is the host's own sync (`promptobus install` standalone), which lays out the adapters after the edit. A consumer whose CLI does have a declaration command says so through its own host.

`--strategy` routes the lift instead: the resolver picks the harness, the model and the effort, and `--harness`, `--model` and `--effort` become constraints on that choice rather than values ([Model routing](#model-routing)). Routing joins the same gate order — everything before any disk write — so a strategy with no candidate leaves no task, no worktree and no participant behind. It routes a LIFT: a repeat spawn at an address already in the journal keeps the harness that address was lifted with, and says the flag was ignored.

`--new-task` and `--task` conflict. Without `--task`, spawn joins the only active task, or opens a new one when several actives exist and this session has no binding. A task owned by another session refuses a silent join.

`--title` names the worker slice. `--task-title` names the task on create. `--dry-run` prints the plan.

The worker gets an isolated git worktree. The main tree is not edited. Read the branch from `promptobus status` or `promptobus_task`, not from the worktree name.

**A repository that generates its process skills** rather than committing them declares the command in its own `promptobus.json`, in the optional `generate` field, as an argv array and never a shell line:

```json
{ "generate": ["npx", "--yes", "github:owner/tool", "init"] }
```

This is the **repository's** file, and it is read by path — the host is not asked, because a generator belongs to the repository being spawned into and a host describes a workspace. `--dry-run` reads the declaration from the clone, because the worktree does not exist yet; the run reads it from the **worktree**, which is what the participant will see, so the two can disagree and the worktree decides.

Where it runs in the order matters three times over. It runs **after the participant record is in the task journal**, so an interrupted generator — `npx` over the network can block for minutes — cannot leave a worktree directory that the next spawn refuses to reuse. It runs **before the launch files**, so a generator writing into the harness config directories is not the last writer. And it runs **before dependencies are installed**, so the worktree has no `node_modules` yet: an `npx …` generator works, an `npm run …` one does not.

Skills in git stay the default and cost this step nothing. A repeat spawn into a surviving worktree does not run it again, and says so without claiming what is still there. A refusal does not refuse the lift — the operator gets a warning with the exit code and a log beside the worktree (`<worktree>.generate.log`); a `generate` that is present but is not an argv array of strings is reported as a broken declaration rather than as no declaration at all. What the generator leaves is checked once it succeeds: files git can see make the worker's branch dirty from its first second and stop `done` from ever sweeping the directory, so the repository must ignore what it generates and the lift says so out loud when it does not.

The participant preamble names the outcome in every case, including "no generator declared": a participant that is never told cannot notice that its repository's rules are missing.

## Review

The path is required. There is no cwd resolve. `--title` is required to open a new review task. `--task` sends a new diff to the existing reviewer. `--base` sets the diff base. `--dry-run` prints the plan.

**The diff file is a snapshot, and a re-review re-snapshots.** `files/review-<worker>.diff` is written once, at the call, and the worker goes on committing: from that moment the file only ages, and a reviewer that trusts it reports closed findings as open (observed twice on 2026-09-06). Nothing locks the worker's tree, so the file is not made to follow it — the age is named instead, in three places. The reviewer's prompt calls the file a snapshot, gives the moment it was taken and the worktree HEAD it was taken from, and sends the reviewer to the working copy itself for the current state before it reports a finding. The command prints the same pair beside the `diff base` line. And the reviewer's participant record keeps it — `metadata.diffAt`, the ISO moment, and `metadata.diffHead`, the worktree HEAD, absent on a repository with no commits — so `promptobus status` and `promptobus_task` answer how far behind the file is, in the participant's line after `bg-session`, without opening the file and without asking the reviewer. Both fields are the adapter's, like `repo`, `worktree` and `session` beside them ([04-protocol](04-protocol.md): the core does not look into `metadata`), and both are absent on a record from a lift older than this release — a participant's line then simply has no snapshot part, the same way it has no `bg-session` part when there is no session. A repeat of the command with `--task` writes a NEW numbered diff file and sends its path to the live reviewer, and the record and the printed pair move to that snapshot with it: a re-review is how a stale file is refreshed, and there is no `--fresh` for it.

The reviewer is read-only. A harness that cannot deny tools must fail before spawn (`src/driver.ts` `denyTools`).

`--strategy` routes the reviewer the same way it routes a worker, with `--role reviewer`'s rules — the quality floor and the diversity bonus ([Model routing](#model-routing)). The worker the review is about is the live participant the pick is measured against. A re-review sends a new diff to a reviewer that is already up, so there is nothing to route and the flag is reported ignored.

## Model routing

The whole surface runs: `models`, `--strategy` and `--allow-payg` on `spawn` and `review`, and the libraries under them — [Availability](#availability-the-adapter-the-preflight-and-the-cache), [Catalog and overlays](#catalog-and-overlays) and the [Resolver](#resolver). This section is the contract [ADR-003](../adr/adr-003-model-routing.md) fixed and PB-13…PB-21 implemented against, written here before any of it so that the shapes, the flags and the codes were decided once instead of nine times, and so the golden fixtures in `test/fixtures/model-routing/` had something to be golden against. It is still written contract-first: what a reader needs is what the surface promises, not the order the promises were kept in.

**Six things this section keeps apart.** They are six different facts about one run, they are decided by different parties, and collapsing any two of them is how a routed pick stops being explainable.

| The fact | Where it is stated | Whose it is | Not the same as |
|---|---|---|---|
| rating of a tuple | `ratings` in `models/catalog.json` ([guides/model-routing.md](../guides/model-routing.md)) | the maintainers, from a named source | anything this account measured |
| runtime availability | the availability snapshot: `available`, `exhausted`, `unavailable`, `unknown` ([Availability](#availability-the-adapter-the-preflight-and-the-cache)) | the local account, as its harness answers | a rating, and never a permanent property |
| remaining subscription limit | `windows[].usedPercent`, scored as `remaining` ([Resolver](#resolver)) | the harness account, in its own windows | zero — unknown is a state, penalised, never blocking |
| money cost | `prices` and `billing` of a catalog row; the gate is `payg-not-allowed` / `--allow-payg` | the plan the account is on | `quotaCost`, which rates subscription spend and carries no money |
| an explicit constraint | `--harness`, `--model`, `--effort` | the person who typed it | a preference — a named value is never replaced |
| the two decisions | the **strategy** is chosen by the agent from the task (`skills/orchestrate/SKILL.md` § Model routing); the **tuple** is chosen by the CLI ([Resolver](#resolver)) | one each | each other — neither party decides the other's half |

**Maintainer note: this section is read as data.** `test/model-routing.test.mjs` (`docSection`) slices this file at four of the `###` headings below, by exact text — `Reason codes`, `Exclusion, adjustment and warning codes`, `Error codes`, `Files` — and reads every table row inside a slice as a declared code, comparing the result against the schema enums in both directions. Three rules follow. A `###` heading added between those four, or one of them renamed, feeds its own tables into a code list: **new subsections go after the `Files` heading**, where every one added since PB-14 has gone. Prose above them must not spell a sliced heading with its `###` prefix, or the slice starts at the mention instead of the heading — which is why this paragraph names them without one. And the failure is loud rather than silent, `a code table came back empty — the headings moved`, but it still costs a confused run to read.

### Commands

```text
promptobus models [--strategy <quality|balanced|speed|economy|balance>] [--role <worker|reviewer>] [--refresh] [--json]
promptobus models validate
promptobus models strategy [--set <quality|balanced|speed|economy|balance> | --clear]
promptobus models --clear-exhausted <harness>
promptobus spawn  … [--strategy <quality|balanced|speed|economy|balance>] [--allow-payg] [--refresh]
promptobus review … [--strategy <quality|balanced|speed|economy|balance>] [--allow-payg] [--refresh]
```

`models` prints what the resolver would pick right now: the chosen tuple, every candidate it considered with its score components, the models the account exposes that the catalog does not rate, and the warnings. Without `--strategy` it takes the **recorded default** and falls back to `balanced` where none is set — the same precedence a lift uses, so `models` and the next `spawn` cannot disagree about what is in force. `--role` defaults to `worker`. The text form prints at most eight unrated rows per harness and counts the rest (`… and N more`); `--json` carries every row, so the two outputs cannot drift.

**`models` has no `--dry-run`, because it is one.** It reads the availability cache and asks no harness anything; `--refresh` is the only flag that makes it probe, and therefore the only one that writes a cache entry. The reason is the ADR's: this is the command a person types to ask a question, and a question that starts three harness binaries and waits out the preflight budget is not one. `--dry-run` belongs to `spawn` and `review`, where the alternative to a dry run is a lift.

**`models` prints the availability it decided on, and both forms print the same one.** Under the candidates comes an `availability:` block: one line per harness with its state and its tier, and under it one line per window — the window's id, its `kind`, the percentage used, its `lengthSec`, what it binds, and its reset time. The block travels **inside the decision document** (`harnesses`, [ADR-004](../adr/adr-004-subscription-balance.md)), assembled by the command from the snapshot after the resolver has answered, because the resolver reads no disk. That is why it is in the document rather than only on the page: `render` prints the decision and nothing else, so a text form fed from a second source would show what `--json` does not carry. The block is optional — a decision assembled without a snapshot in reach is still a decision, and prints no such section.

A `kind` is a **name** and `lengthSec` is the **number**, and the line prints both without deriving one from the other: a `monthly` billing cycle is not thirty days, and a label invented from a length would be a second, quieter claim about the same fact. A window binds `account`, one `model` family by the name the harness gave it, or one `pool`; the ids behind a scope are in `--json` for a machine and not on the page for a person.

**The age is the facts', not the run's.** `snapshot.takenAt` in a decision is the OLDEST entry's own `checkedAt`, and `ageSec` measures from it: a snapshot is only as fresh as the stalest thing inside it, which is the rule the cache TTL cascade already applies to a single entry. The moment the command ran is not it — a cache-only run would print `0 s old` over an entry from yesterday, and a mixed run, where one harness answered a second ago and two are hours old, would report the freshest of the three. A cache the run never held carries the epoch as its stamp, so a first run says its facts are ageless rather than freshly measured; `stale_cache` on every harness row says the same thing again. The text output prints that case as `snapshot: never checked · source cache` and no age — an age counted from the epoch is true and useless — while `--json` keeps the literal `takenAt` and `ageSec`, because a machine reader wants the number and a person does not.

`--json` prints the decision document; its shape is `schemas/model-routing/decision.schema.json` and it is pinned by `test/fixtures/model-routing/decision.json`. The text output is pinned byte for byte by `models.txt` next to it: candidates are printed in the order the decision document lists them — scored first by descending total, then excluded ones by canonical priority.

**The text form ends with one line about the telemetry file** — how many records it holds and how large it is, and nothing read out of the records; reading them back is a later series. The line is printed beside the decision rather than inside it, and `--json` does not print it at all: that form is one document a machine parses, and the count is not a field of it. See [Participant telemetry](#participant-telemetry).

`models validate` checks the catalog and every overlay: schema, references to tuple, model and harness, rating ranges, weight sums, duplicate ids, and rules that both allow and deny the same name.

`models --clear-exhausted <harness>` drops an exhaustion the cache is holding with no known reset. Nothing else clears one: an exhaustion with a reset expires by itself.

`--strategy` on `spawn` and `review` hands the resolver an intent. `auto` is not a value here — the orchestrating agent turns a task into one concrete strategy before the call. Without `--strategy` the command takes the **recorded default** if one is set, and otherwise today's path exactly, with today's defaults.

**Precedence: flag → overlay default → none.** `--strategy` on the command line always wins, which is the rule [ADR-003](../adr/adr-003-model-routing.md) fixed for `--harness`, `--model` and `--effort` — a named value is never replaced. Below it, `defaults.strategy` from the merged overlays: a scalar, so the highest layer that names one wins. Below that, nothing — and nothing is the legacy path, so ADR-003's "a call with no `--strategy` routes nothing" still holds word for word where no layer sets one. A lift routed by the default records `strategySource: "overlay:<layer>"` on its decision and in `metadata.routing`, so a run made under a switch a person agreed to is auditable as one; a lift routed by a flag records no source, because there is nowhere else the value could have come from.

Reading the default costs the overlay files and no probe, so a `spawn` that routes nothing still asks no harness anything.

`promptobus models strategy` with no argument prints the effective default and the layer that set it. `--set <name>` writes `defaults.strategy` into the host's **writable** layer ([02-host](02-host.md)): it keeps every other key of that file, creates it with a `schemaVersion` when it is not there, writes atomically with mode `0600`, and **refuses when no layer is writable** — a host that declares layers and marks none, or declares none at all, has nowhere to keep the value and is told so rather than written to somewhere of the tool's choosing. `--clear` removes the key and leaves the rest. When what was just written is shadowed by a layer above the writable one, the command says so: the value would otherwise sit on disk doing nothing.

**One question the tool cannot answer, and no command writes it.** Today there is one — Cursor's plan name, which no method returns. It lives in the **user** overlay under `account: { "<harness>": { "plan": "<name>" } }`. `models` prints the key, the value where a person set one and the layer it came from, and the path to add it to where they have not; a person or an agent adds the line. There is no writer for two reasons: the writable layer is per-workspace, so a tool-written answer would be given again in every workspace, which is the opposite of "asked once"; and declaring a second writable layer to carry one string would make "exactly one writable layer" false the first time it was used. The value is **display only and enters no score**, and the snapshot keeps what was measured — a typed string never reaches the cache.

`--allow-payg` admits pay-as-you-go tuples, which are otherwise excluded from automatic selection.

`--harness`, `--model` and `--effort` remain **constraints, not wishes**: a named value is never replaced. If the named combination is unavailable or exhausted, the command ends with diagnostics.

`--dry-run` on `spawn` and `review` prints the decision as part of the plan and **reads the cache and nothing else**: no probe, no binary started, no network, and no write. A probe happens only when `--refresh` asks for it, and `--refresh --dry-run` probes but still writes neither a cache entry nor task state. A snapshot that is stale or absent is reported in the decision — `stale_cache` on the harness, plus a `snapshot-stale` warning — never silently taken as fact; a cache that was never written carries the epoch as its `checkedAt`, so "never checked" and "expired" read apart. A dry run is how a person asks a question; a question that starts three harness binaries and waits fifteen seconds is not one, so the flag that costs time is the one that says so.

### Reason codes

The state of one harness in the availability snapshot, with its reason. `snake_case`, quoted verbatim from ADR-003 — the snapshot vocabulary keeps the spelling the decision fixed, while package error codes below follow the `kebab-case` of `ERROR_CODES` (`src/v1/errors.ts`).

Eight codes, and ADR-003 named a ninth. `model_not_available` was **retired before anything ever wrote it** (PB-21.1): a snapshot entry's state is the HARNESS's, so the only state that code could have accompanied is an `unavailable` that takes every tuple of that harness with it — which is precisely what the decision forbade for a model absence. The fact it was meant to carry is per tuple and is already reported per candidate, as the `model-not-in-inventory` exclusion below, with the better diagnosis. It is gone from the schema enum and from `AVAILABILITY_REASONS` together with this table; the drift check reads the two and keeps them one list.

| Code | State it accompanies | Meaning |
|---|---|---|
| `binary_missing` | `unavailable` | The host's `resolveToolBin` found no binary for that harness |
| `not_authenticated` | `unavailable` | The binary is there, the account is not logged in |
| `subscription_exhausted` | `exhausted` | The limit is confirmably spent; `resetAt` when the harness gives one |
| `probe_timeout` | `unknown` | The adapter did not answer inside the 15 s preflight budget |
| `probe_failed` | `unknown` | The adapter answered with an error that is not one of the above |
| `quota_unknown` | `unknown` | Auth is fine and the remaining limit could not be established — the harness exposes no source for it, or the source it does expose could not be read this time |
| `stale_cache` | `unknown` | The cache entry is absent or outlived its TTL and no probe ran — `--dry-run` without `--refresh`, or the preflight budget was spent. The two cases are told apart by the stamp, not by a second code: an entry that expired keeps its own `checkedAt`, one the cache never held carries the epoch — never checked. `source` stays `cache` for both, because the cache is what was consulted and the enum has no fourth value |
| `manual_exhaustion` | `exhausted` | A limit the machine observed and no reset time is known for. `markExhausted` writes it when a lift was refused on a spent limit and the harness named no reset; nothing else writes it, and **no person marks a harness in v1**. The code says who may clear it — only `--clear-exhausted` — not who wrote it |

### Exclusion, adjustment and warning codes

Why a candidate did not reach scoring, what moved its score, and what the person is told. `schemas/model-routing/decision.schema.json` carries the same three enums; this table is the prose half.

| Kind | Code | Meaning |
|---|---|---|
| exclusion | `model-not-in-inventory` | The catalog rates the tuple; the account does not expose that model |
| exclusion | `role-not-allowed` | The tuple is not rated for the role being routed |
| exclusion | `constraint-mismatch` | An explicit `--harness`, `--model` or `--effort` rules it out |
| exclusion | `denied-by-policy` | An allow/deny rule of the merged policy; `detail` names the rule and **every** layer that wrote it — a deny list accumulates, so a ban two layers wrote is lifted in neither of them alone |
| exclusion | `payg-not-allowed` | Pay-as-you-go without `--allow-payg` |
| exclusion | `harness-unavailable` | The harness snapshot is `unavailable` |
| exclusion | `harness-exhausted` | The harness snapshot is `exhausted` |
| adjustment | `unknown-availability` | −10: the remaining limit is unknown, counted as a neutral 50 % |
| adjustment | `live-participant` | −5 per participant already live on that harness, capped at −20 |
| adjustment | `reviewer-diversity` | +5: this reviewer's harness or model differs from the worker's |
| warning | `stale-rating` | A tuple's `assessedAt` is old. A warning only — never an exclusion |
| warning | `unknown-remaining` | At least one harness could not report its remaining limit |
| warning | `reviewer-floor-not-met` | No reviewer candidate reached the quality floor; the best remaining one was taken |
| warning | `worker-floor-not-met` | The same for the worker's floor, which [ADR-004](../adr/adr-004-subscription-balance.md) added at 3 |
| warning | `near-limit` | A harness whose binding window is at or past `nearLimit.usedPercent` (80), or whose underspend is below `nearLimit.underspend` (−15 points). The line names the window, its reset, which of the two tests tripped, and the strategy to propose — it never switches one |
| warning | `balance-fallback` | `--strategy balance` and no harness could be paced — every candidate's binding window is unknown, spent or already reset. The pick was scored by the `balanced` weights, not balanced |
| warning | `snapshot-stale` | The decision was made on cache entries past their TTL |
| warning | `probe-incomplete` | An adapter missed the preflight budget and its harness is `unknown` |
| warning | `flag-not-in-inventory` | An overlay's `flags` rule names a mark no model of this run's snapshot carries. The rule excluded nothing — and a harness that lists no models has no flag to match, so silence is not absence |

### Error codes

Routing failures end the command. Every one of them happens **before any write**: no task, worktree or participant exists when they fire — except `limit-hit-at-start`, which is the one case where the store is already written and the command says so.

They are `PromptobusError` codes and live in `ERROR_CODES` (`src/v1/errors.ts`) — which is why they are `kebab-case` while the snapshot's reason codes above keep the `snake_case` the decision fixed. The drift check reads this table against that list, so the two cannot part.

`limit-hit-at-start` is raised by the lift itself (`lib/liftoff.js`): the two refusal branches that hold the harness's own words — a non-zero exit and a session that never came up — throw a `PromptobusError` with that code **when the late-start hook marked the cache**, and end through `fail()` when it did not. So the code means both halves at once: the limit was hit AND the harness is now marked exhausted. A limit refusal whose mark could not be written — an unreadable routing path, a read-only directory — leaves through `fail()` with no code, because there is no mark for a consumer to act on and the person still gets the same diagnosis. What a person reads does not change either way: the CLI catch prints a `PromptobusError` as one line and exits 1, exactly as `fail()` does.

| Code | When |
|---|---|
| `strategy-unknown` | `--strategy` is not one of the five values |
| `role-unknown` | `--role` is not `worker` or `reviewer` |
| `harness-unknown` | A harness the workspace does not declare is named — by `--clear-exhausted`, or by `--harness` on a routed `spawn` or `review`. The routing catalog is filtered by the declaration, so a tuple of an undeclared harness is never in the snapshot to be chosen from |
| `catalog-invalid` | The shipped catalog fails schema or reference validation |
| `overlay-invalid` | An overlay fails schema, reference or contradiction validation; the message names the layer |
| `constraint-unknown` | An explicit `--harness`, `--model` or `--effort` matches no tuple in the merged catalog. A `--harness` the workspace never declared is refused by `harness-unknown` before this one: "you do not have that harness" is the more useful of the two answers |
| `constraint-unavailable` | The explicitly named tuple exists but its harness is `unavailable` or `exhausted` |
| `candidates-empty` | Nothing survived filtering. The decision document is still printed, with `chosen: null`. It ends `spawn` and `review`; `models` prints the document and exits 0, because answering the question is what that command is for |
| `limit-hit-at-start` | The limit was hit between preflight and start **and** the cache was marked exhausted; the command does not retry. A mark that could not be written leaves through `fail()` without the code |

### Files

| What | Where | Notes |
|---|---|---|
| catalog | `models/catalog.json`, shipped with the package | `schemas/model-routing/catalog.schema.json` |
| overlays | `host.routingPaths().overlays`, lowest precedence first | standalone: `user`, then `workspace` — the **writable** one, at `<promptobusHome>/model-routing.json`, which is what `models strategy --set` writes ([02-host](02-host.md)) |
| availability cache | `host.routingPaths().cacheFile` | mode `0600`; no prompt, token, email or open account id |
| participant telemetry | `telemetry.jsonl` beside the cache | mode `0600`; JSON Lines, `schemas/model-routing/telemetry.schema.json`; the same rule, plus no path, no session id and no message body |

### Availability: the adapter, the preflight and the cache

The harness-neutral half: the adapter contract, the budgeted preflight and the cache. Each adapter has its own subsection below; a driver that declares none answers `unknown` / `probe_failed`, which the resolver penalises rather than blocks.

**The adapter** is a `tool` name and one method, declared by a driver as `availability` (`src/model-routing.ts`, `src/driver.ts`):

```ts
tool?: string
probe({ host, toolBin, timeoutMs, refresh }): ProbeVerdict | Promise<ProbeVerdict>
```

`toolBin` is the binary of `tool`, resolved by the preflight **before any adapter started**; an adapter that declares no `tool` is handed `null`. **An adapter does not call `resolveToolBin` itself**, and the reason is the next rule. `timeoutMs` is what is left of the preflight budget when the adapters start — they run in parallel, so each may use all of it. The verdict is one harness entry of the availability snapshot, so nothing translates between a probe and the file:

| Field | Meaning |
|---|---|
| `state` | `available`, `exhausted`, `unavailable` or `unknown` |
| `reason` | one of the eight codes above, `null` exactly when the state is `available` and nothing qualifies it |
| `message` | a human diagnosis. **Never harness output verbatim**: this is the one free-text field that reaches disk |
| `checkedAt` | ISO-8601 with milliseconds; the preflight stamps one if the adapter omits it |
| `source` | `probe` — this run asked the harness; `cache` — a live entry was reused; `manual` — a person marked it. **Nothing in v1 writes `manual`**, the late-start mark included: it is written under `probe`, because the harness itself said so when it refused to start. The slot is reserved for a person typing it, which no command offers. Do not read `manual_exhaustion` as this value — the reason says who may clear the entry, the source says who learned it |
| `resetAt` | when an exhausted limit is known to reset; `null` means unknown |
| `version` | the harness binary version, when the probe read it |
| `tier` | the plan the account is on, `{ name, source }` or `null` (ADR-004). `source` is `credentials`, `probe`, `derived` or `user`. **The name is shaped like a code** — no spaces, no `@` — because it is the second adapter-authored string that reaches disk and `message` is meant to be the only free-text one. Carried and displayed; an input to no score |
| `credits`, `resetCredits`, `spendControlReached` | informational, and Codex is the only harness with them: whether the account holds spendable credits at all, how many window resets it may spend, and whether its own spend control says it is at its ceiling. Nothing scores them and nothing spends a reset — the **amount** is deliberately not carried, being a fact about the account rather than about the plan, while a boolean about the plan's policy is not |
| `models` | the inventory the account exposes. An adapter does not fill `rated` — it knows the harness, not the catalog. A row the harness lists and declines to offer is carried with `hidden: true` (ADR-004): a person asking `models` sees the whole inventory, and the resolver's inventory is the rows without it, so a tuple naming one is excluded as `model-not-in-inventory` |
| `windows` | normalised limit windows. A harness that exposes none reports none; the remaining limit is then unknown, never modelled. Since ADR-004 a window states `kind` (`session`, `weekly`, `monthly`), `lengthSec`, `usedPercent`, `resetAt` and an explicit `scope` — `null` for the whole account, `{ model, models? }` for one family, `{ pool: "auto", models }` or `{ pool: "api" }` for Cursor's two pools. **A scope that covers models names them by id**, so nothing infers a family from a display name |

**A probe must not block the event loop**, and that is a rule of the contract rather than a style. The preflight runs every adapter at once and bounds them with a timer beside their promises: a probe that holds the loop stops that timer from firing, stops its neighbours from making progress, and stops its own kill timer — the 15 s ceiling then becomes the sum of the blocking probes, and the mechanism meant to cap it cannot run while it is blocked. So no `spawnSync`, no synchronous host call, no busy wait. A synchronous **return** is still lawful and is what an immediate answer looks like: the rule is about holding the loop, not about returning a promise. `resolveToolBin` is the call this rule took out of the adapters — it is synchronous by contract and a host may start a process inside it, which no adapter could have fixed from its own side.

**The deadline is answered on, never waited past.** An adapter that kills its child when its deadline passes answers there and then, and lets go of the pipe and the child handle in the same breath. `close` fires when the last stdio pipe closes rather than when the child dies, so a process the harness left behind — a wrapper's `sleep`, any grandchild that inherited the pipe — keeps a probe that waits for `close` pending long past the kill, and an unread pipe holds the command open after the verdict was already written. Measured 2026-09-05 on all three adapters against a `#!/bin/sh` wrapper whose `sleep 5` held the pipe, with a 300 ms deadline: the verdict at ~305 ms, and the run held 5.2 s past it until the pipe was released.

An adapter that **throws** is `unknown` / `probe_failed`, and the thrown text is discarded rather than written: an adapter wrapping harness output in an error would otherwise put it on disk. An adapter with something to say answers with a verdict.

An adapter that **answers outside the contract** is `probe_failed` too, and the diagnosis names the field. All three closed lists are checked — the state, the reason and the source — plus a `checkedAt` that cannot be read; a reason is required for every state but `available`, which is the only one none of the eight codes accompanies. The written cache promises to validate against its schema, and a misspelt `quota-unknown` would break that promise from inside: the command would report success and leave a document nothing can read back. The offending value is quoted back only when it has the shape of a code, so the message can show a typo without becoming a second route for harness output.

Inside `models` and `windows` the check is by value and it **drops the element, not the verdict**: a blank model name, a `usedPercent` outside 0…100, a missing or unknown `kind`, a missing `lengthSec` or one of zero, a flag outside the closed list, a scope that is none of the three shapes. An adapter that garbles one row of an inventory still knows whether the account is logged in, and nothing here repairs a value — a number invented by the mechanism would validate while saying what no harness said. A `resetAt` that cannot be read becomes `null`, the schema's own word for unknown.

Two of those drops are ADR-004's and are worth their own sentence. A window with **no length has no pace** — `elapsedShare` cannot be computed from it — so an adapter that cannot state a length reports no window, which is already the rule for a harness that exposes none. And a **garbled scope takes its window with it** rather than becoming `null`: `null` is the claim "this binds the whole account", and widening a per-model weekly cap into an account-wide one would apply it to every tuple of that harness. The one scope that legitimately arrives incomplete is a model scope with no resolved ids — the adapter could not turn the harness's display name into catalog ids — and that window stays, is printed for a person, and binds nothing.

The **tier** is dropped to `null` rather than costing the verdict, for the same reason: nothing scores it, so losing it costs a line of output. The **flag list is closed** (today one mark, `no-zdr`, in the snapshot schema's own enum) because an overlay may deny by a flag, and a name checked against nothing would let a typo ban silently nothing; the price is that a new mark a harness starts printing needs a release rather than a data change.

**The preflight** (`lib/model-routing/preflight.js`) runs every adapter at once under one total budget of 15 s (`PREFLIGHT_BUDGET_MS`). A harness that has not answered by then is `unknown` / `probe_timeout` and does not hold the command: the person waits once for the slowest harness, never three times in a row. The result is the availability snapshot, valid against `schemas/model-routing/snapshot.schema.json`.

**It resolves the binaries first, once each, and the budget covers that too.** Every adapter's `tool` is resolved before the race — one call per binary name, so two harnesses naming one binary cost one resolve — and each probe is handed its answer. A host that has no `resolveToolBin`, or whose call throws, yields `null` for that harness, and the adapter says in its own words what a missing binary means. The resolve runs under the same deadline as the probes: when it is spent, no further binary is resolved and the harnesses that were never reached report `probe_timeout` saying the budget went on resolving — a slow harness and a slow host send a person to different places. A synchronous call cannot be interrupted, so a run may outlive its budget by the one resolve already in flight, and by no more.

What is asked, and what is taken from the cache:

| Run | Probed | Taken from the cache |
|---|---|---|
| plain | harnesses with no live entry | every live entry |
| `--refresh` | everything except a reset-less exhaustion | a reset-less exhaustion, which no probe can lift |
| `--dry-run` | nothing | every live entry; the rest is `unknown` / `stale_cache` |
| `--refresh --dry-run` | as `--refresh` | as `--refresh` — and nothing is written |

**The cache** (`lib/model-routing/cache.js`) sits at `host.routingPaths().cacheFile`, mode `0600`, written as a temporary neighbour and renamed over, with its directory created as needed. Entries are merged, never replaced wholesale: a late-start mark writes one harness without re-probing the others.

**Two commands writing at once do not lose each other's entries.** The rename keeps a reader from ever seeing half a document, but it cannot make the read-merge-write one step: a `spawn` and a `models --refresh` in another terminal would both read the same document, both merge their own harness into it, and the second rename would win — the loser's entries gone and its harness re-probed next run. So a writer holds a lock file next to the cache (`<cacheFile>.lock`) across the read, the merge and the rename. A lock somebody else holds is waited out for up to 2 s; one older than 15 s is a process that died between its read and its rename and is broken rather than waited for. **A lock that cannot be taken is not a refusal**: after the wait the write happens anyway, because a cache that refused to write would lose exactly the entries the lock exists to keep — the worst case is the behaviour that was there before the lock. `clearExhausted` takes the same lock, being the same read-modify-write of the same document.

**A cache of another `schemaVersion` is discarded, never migrated** (ADR-004). The document version is 2 since the tier, the window `kind` and `scope`, and the `hidden` mark arrived; a file of any other version is read as a cache that holds nothing, so every harness reports `unknown` / `stale_cache` and the next run probes. The reason is what the file is: its shortest fact lives sixty seconds and its longest an hour, so a reader for the old shape would buy at most one hour of not asking and then be kept forever. It costs one entry that no TTL clears — a reset-less exhaustion — once, at the upgrade, and the next lift that hits the limit writes it again through the same hook. The message beside `stale_cache` says which of the two happened: a first run reads `no cache entry for this harness`, a discard reads `the cache was written by an older version (schemaVersion N) and was discarded`, because a person meeting the second in the words of the first would go looking for a bug that is not there.

**A preflight that probed nothing writes nothing.** The merge re-stamps the document's `takenAt`, so a run served entirely from live cache entries used to rewrite the same entries under a fresh stamp — and a reader ageing a snapshot from that stamp would report the age of the last run rather than the age of the facts. A run with an empty answer set has learned nothing and has nothing to say about when.

TTLs, as a cascade — the first line that matches an entry wins:

| Entry | Live until |
|---|---|
| `exhausted` with a `resetAt` | that reset |
| `exhausted` with no `resetAt` | `--clear-exhausted`, and nothing else. `--refresh` does not lift it, and such a harness is not even probed |
| `probe_timeout` or `probe_failed` | `checkedAt` + 5 min |
| carries `windows` | `checkedAt` + 60 s — an entry is only as fresh as the fastest fact inside it |
| anything else | `checkedAt` + 1 h — auth, model inventory and the tier, which changes about as often as a login does |

The file holds **no prompt, no token, no email and no open account id**. The mechanism is not a filter but the shape: a verdict is projected field by field onto the closed snapshot schema before it is written, so anything an adapter attached beside the declared fields never travels. v1 assumes one locally authenticated account per harness, so the file carries no account key at all; the schema keeps a `fingerprint` slot for the day that changes, and the rule that comes with it is that the key must be opaque and one-way.

Two library entry points sit behind the commands. `clearExhausted(host, harness)` is what `--clear-exhausted` calls: it drops a reset-less exhaustion and reports whether there was one, and it leaves an exhaustion that names its reset alone. `markExhausted(host, harness, { resetAt, reason })` is the late-start hook — a driver whose session failed to start on a limit calls it. Without `reason` the code is derived from the evidence the helper can see: `subscription_exhausted` with a reset, `manual_exhaustion` without one. `reason` is how a caller states evidence the helper cannot see, and there is one such case: a harness that says the limit **resets** and names the time in a person's words and a person's timezone ("resets at 3pm") is a subscription limit whose reset nothing may parse, so it is `subscription_exhausted` with `resetAt: null` — a pair the derivation cannot express. That is the reason the Claude driver's late-start mark carries when the refusal named a reset; a refusal that explained nothing carries `manual_exhaustion`. **Both are sticky**, because neither has a `resetAt`: with no reset the reason says who the limit belongs to, not when it comes back, and `--clear-exhausted` is the only door out of either. A `reason` outside the two codes falls back to the derivation rather than writing a code the snapshot schema does not have. Its `source` is `probe`, not `manual`, and the two words are about different things: the harness itself said so — it was asked to start and answered — while `manual` means a person typed it, which nothing in v1 does. The reason code is what carries "only a person clears this"; the source carries who learned it. The mark is per harness, not per tuple: the snapshot has no tuple dimension, and a limit is an account fact. A `dryRun` option makes every one of these writes a no-op.

### Catalog and overlays

The catalog file, the layer merge and the checks `models validate` prints. The operational half — what is in a row, how the layers combine, the canonical-priority convention, and the overlay file a person copies — is [guides/model-routing.md](../guides/model-routing.md).

Three library entry points, all in `lib/model-routing/`:

| Call | What it answers |
|---|---|
| `loadCatalog({ host, constraints })` | the merged tuple list and policy: the shipped catalog, then every overlay `host.routingPaths().overlays` names in that order, then the caller's constraints. A missing overlay file is normal; a present but unreadable one is a `GateError` |
| `validate({ host, constraints })` | `{ ok, errors, warnings, layers }` for the real stack. A broken file is a finding here, not a throw — this is the call a person makes when a file is broken |
| `validateLayers({ canonical, overlays, constraints, now })` | the same verdict for documents already in memory: `canonical` is `{ data }`, each overlay `{ id, path, present, data }`. Pure, so a consumer can check a policy layer it ships without touching disk |

`--harness`, `--model` and `--effort` reach the merge as constraints and are carried through untouched — the resolver applies them. `--allow-payg` is the one constraint that changes policy at that layer, and it is opt-in: its absence does not undo an overlay that opted pay-as-you-go in.

**A ban is final from below, and a `deny` list accumulates.** [ADR-004](../adr/adr-004-subscription-balance.md) decision 5 supersedes ADR-003's "Clarification, 2026-09-05" whole: a deny list of any selector kind is the **union** across every layer that states one. A ban written in any layer stands, no layer above it lifts one, and lifting one means editing the layer that wrote it.

```text
// user layer                        // workspace layer, above it
{ "deny": { "tuples": ["a"] } }      { "deny": { "tuples": ["b"] } }
// merged: deny.tuples = ["a", "b"] — both bans hold
```

Under the old rule the workspace layer's list replaced the user's, and `a` came back. That is the cost the first consumer measured: to make its own bans hold it had to sit above a person's file and erase that person's `deny.tuples` with it.

**An `allow` list intersects.** A tuple must be named by every allow list of that kind that any layer states, so one sentence covers both lists — *a layer's rule survives every layer above it* — which is the sentence the resolver already applies across selector kinds, with the layer as one more axis. Two layers narrowing different ways therefore intersect to nothing, and a file that says "allow" then admits no tuple at all; that case is checked rather than discovered, below. An intersection that came out empty is an allow list which admits nothing, and it is not the same document state as no allow list of that kind.

Neither list can be cleared: the overlay schema refuses `deny: {}` and `deny: { models: [] }` alike, and every denied name must exist in the merged catalog, so "deny nothing" cannot be written.

**Two more selectors**, both additive and both usable in `allow` and `deny` alike:

| Selector | What it names | Where it is applied |
|---|---|---|
| `flags` | a mark the availability **snapshot** carries on a model row — today one, `no-zdr`. It is the one selector whose names are in no catalog, so they are checked against a closed list (`MODEL_FLAGS`, mirrored into the overlay schema's own enum and into the snapshot's). A new mark a harness starts printing needs a release rather than a data change | after the inventory step of the resolver, because that is where the model row it reads arrives |
| `byRole` | a nested rule block scoped to `worker` or `reviewer` — `deny: { byRole: { reviewer: { harnesses: ["cursor"] } } }`. A role is a condition on *when* a rule applies rather than a thing that can be banned, which is why it nests instead of standing beside the four names. Routing role R, the effective deny of a kind is the unscoped list unioned with `byRole.R`'s, and the effective allow is the intersection of the two where both are stated. `validate` refuses a role outside the two | wherever the rule it wraps is applied |

**Silence is not absence.** A harness that reports no inventory has no flags to match, so a flag deny excludes nothing there: a person who must never run outside zero-data-retention does not get that guarantee from a harness that lists no models, and the reference says so rather than appearing to. Read the other way, the same fact settles the allow half — `allow.flags` means "only models carrying this mark", and a tuple whose mark cannot be seen is not one of them, so it is excluded. A rule whose flag no model of the run carries raises the `flag-not-in-inventory` warning.

`validate` covers the shape of every layer, duplicate tuple ids, a harness no driver of this CLI drives, an effort outside that driver's `EFFORT_LEVELS`, weights that do not sum to 100, references to a tuple, model, harness or effort that does not exist, a flag outside the closed list, a role outside the two, a name that is both allowed and denied **in one layer** — which nobody writes on purpose — a rated row whose rating has nothing behind it, and the host's own declaration: exactly one layer is writable whenever any layer is declared, reported here as a finding on the layer `host` rather than thrown, because a person whose host declares none would otherwise be told by `models validate` that their stack holds and by `models` that it does not. The layer list it prints marks the writable one. Three checks are ADR-004's, and every one of them names the layer that wrote each half. They are named by a `rule` field on the finding rather than by an error code of their own: `models validate` raises the code of its first finding, so a new value there would change what a consumer branching on `overlay-invalid` receives.

**A rating with nothing behind it is `catalog-invalid`.** ADR-004 rates from published results, and `evidence` grew the object form that carries the citation: `{ text, sources, interpolatedFrom, hypothesis }`, with the bare string still lawful for a row written before it. Each entry of `sources` names one rating and its `basis`, `version`, `agentHarness`, `provenance`, `figure`, `fieldSize`, `url` and `date`. For each of `quality`, `speed` and `quotaCost`, a row states one of three things and `validate` refuses a fourth: the rating is cited in `sources`; the row is `interpolatedFrom` a base row that cites it, which is why an `interpolatedFrom` naming no tuple is itself an error; or the rating is named in `hypothesis`, which is the ADR's "no published number" said in a form a reader can find. Naming a rating in both `sources` and `hypothesis` is an error too — it is one or the other.

| Check | Kind | What it says |
|---|---|---|
| `allow-intersection-empty` | error, under `overlay-invalid` | the allow lists of one selector kind intersect to nothing across the layers that state one, so no tuple is admitted. Without this the symptom would be `candidates-empty` with no explanation |
| `deny-covers-allow` | error, under `overlay-invalid` | every name the intersected allow list admits is denied somewhere |
| `allow-shadowed-by-deny` | warning | a name allowed in one layer and denied in another. Under replacement this was the contradiction ADR-003 asked `validate` to refuse; under union it is lawful and deny wins, so it becomes a warning that sends the person to the file which took their allow list away |

`models validate` also prints the deny rules in force, each with the layer that wrote it and the sentence that **only that layer can lift it** — no allow list anywhere reaches a ban, because deny is applied after allow.

Its other warnings are `stale-rating` — a rating older than `STALE_RATING_DAYS` (90), never an exclusion — and two of its own, `priority-duplicate` and `priority-not-canonical`, which check the canonical-priority convention the guide documents and never reach a decision.

A finding carries `code`, the `layer` id it belongs to, `at` for the field, `message`, and `rule` where the check has a name of its own (the three above). `layer` is whoever wrote the key in question — the overlay that wrote that weight set, or the one that wrote the deny half of a pair, and `defaults` where none did. A merged list has as many writers as there are layers that stated one, so the merge records every allow and deny rule rather than one layer id per key. A warning carries `code` and `message` first and its facts after: those two fields are the whole of a warning in the decision document (`warnings` in `decision.schema.json` is closed on them), **so a decision copies `code` and `message` and translates nothing**.

### Claude Code: what its adapter asks

Implemented (PB-15, extended by PB-26). The adapter is declared as `availability` on the Claude Code driver and lives in `lib/model-routing/adapter-claude.js`. One probe is **one auth check, one local credential read and one HTTP GET — and no turn**.

| Fact | Where it comes from |
|---|---|
| binary, version | the preflight's resolve of `claude`, handed over as `toolBin` — the adapter neither searches `PATH` nor resolves anything itself |
| auth | `claude auth status --json` |
| models | the driver's own dictionary: the pinned ids the catalog rates, its alias set, and its `DEFAULT_MODEL` (`lib/driver-claude.js`) |
| tier | `claudeAiOauth.rateLimitTier` in the local credential record, read with **no request at all** — `{ name, source: "credentials" }`. Only when the record names none is `GET /api/oauth/profile` asked for `organization.rate_limit_tier`, and then the source is `probe` |
| remaining limit | `GET https://api.anthropic.com/api/oauth/usage`, the endpoint Claude Code's own `/usage` command reads (measured 2026-09-06 on 2.1.251) |

**Nothing runs `claude` with a bare word.** An unrecognised word after the binary name is not an unknown subcommand — it is taken as a PROMPT and starts a turn on the person's plan. So the argv is a subcommand `claude --help` lists with flags that subcommand's own `--help` lists, and the suite pins it whole.

**The inventory is not a listing.** On `claude` 2.1.251 the binary publishes no model list at all: no `models` subcommand and no `--list-models` (`claude --list-models` → `error: unknown option`, exit 1). So the inventory is the driver's dictionary — `MODEL_IDS`, `MODEL_ALIASES` and `DEFAULT_MODEL` — handed to the adapter by the driver rather than imported back out of it, because a module of the mechanism reaching into a driver is the crossing the adapter-boundary gate refuses. **This adapter imports no driver module at all** — the dependency runs one way, `driver-claude.js` → `adapter-claude.js` — so it passes that gate on its own and is deliberately absent from the gate's `DRIVER_OWN` exemption list: an exemption a file does not need would hide the crossing the list exists to catch. It is in `DRIVER_PRIVATE` instead, which is the other half of the same rule — the driver may import it, and nothing else in `lib/**` may. A name in that list the catalog does not rate is not a mistake: it becomes an unrated runtime row, which is what the three aliases are.

**The rated names are full ids, and the aliases are not.** `--model` takes either — its help says "an alias for the latest model … or a model's full name (e.g. 'claude-fable-5')" — but an alias names whatever the vendor points it at today, so a catalog row keyed on one keeps its ratings and its `assessedAt` through a re-point and starts describing a model nobody assessed, with nothing going red. The rated rows therefore name `claude-fable-5`, `claude-opus-5` and `claude-sonnet-5` (`MODEL_IDS`), the suite pins every Claude row against that set, and the hazard is written for a person in [guides/model-routing.md](../guides/model-routing.md). `claude-fable-5` entered both in PB-29: it is what the binary's baked model catalog resolves the `fable` alias to (`fable:{default:"claude-fable-5"}`, `latest_per_family.fable`, `best:"fable"`, empty `alias_migration`), read offline out of 2.1.251 with no paid turn, and rating an id the inventory did not carry would have excluded every Fable row as `model-not-in-inventory`. The lift is untouched: an alias is as lawful at `--model` as it ever was, and `DEFAULT_MODEL` is still one.

**`claude auth status --json`** is the whole auth check, and it is the one non-interactive check the binary offers today (measured 2026-09-05 on 2.1.251: three runs at 0.86 / 1.17 / 1.36 s, exit 0, one JSON object). Its keys are `loggedIn`, `authMethod`, `apiProvider`, `analyticsDisabled`, `projectsDirectory`, `email`, `orgId`, `orgName`, `subscriptionType`. **Exactly one of them is read** — the `loggedIn` boolean. Three of the rest are an email address and an open account id, which the cache promises never to hold, so they stop at the adapter and the suite greps the written snapshot for them.

**Where the credential is read from, and what is taken out of it.** On macOS it is a keychain generic password — service `Claude Code-credentials`, account the OS user — read with `/usr/bin/security find-generic-password -s 'Claude Code-credentials' -w`. The path is absolute rather than resolved through `PATH`: every other binary this package runs is the host's to resolve, and this one is a platform tool being handed a request for a token. Everywhere else the record is the file `~/.claude/.credentials.json`, read if it is there. **The Linux path is not measured** — the spike of 2026-09-06 ran on macOS, the file's shape is the same JSON by Claude Code's own documentation, and that is the whole of the evidence for it.

The record's `claudeAiOauth` block carries `accessToken`, `refreshToken`, `expiresAt`, `scopes`, `subscriptionType` and `rateLimitTier`. **Three fields are read and no fourth**: the access token, the expiry and the tier. `refreshToken` is never parsed out at all, so it cannot travel by accident, and the token that is read reaches exactly one place — the `Authorization` header of the GET below. It is in no verdict, no message and no cache file, and the suite greps both the verdict and the written snapshot for it.

**The adapter never calls the refresh endpoint.** A refresh rotates the credentials Claude Code itself is holding, so a preflight that did it would sign a person out of the session they are working in. A token past its `expiresAt` is reported, not repaired: `unknown` / `quota_unknown` with the tier still on the harness, because the tier was read offline and an expired token does not unknow it.

**The call, and how the answer becomes windows.** `GET /api/oauth/usage` with `Authorization: Bearer <access token>`, `anthropic-beta: oauth-2025-04-20` and `Accept: application/json`. The answer's `limits[]` is the only part read — the top-level `five_hour` and `seven_day` objects duplicate two of its rows, and neighbouring keys with odd names are experiments. Three row kinds are placed and the rest are left out:

| Row | Window |
|---|---|
| `kind: "session"` | `{ id: "session", kind: "session", lengthSec: 18000, scope: null }` |
| `kind: "weekly_all"` | `{ id: "weekly", kind: "weekly", lengthSec: 604800, scope: null }` |
| `kind: "weekly_scoped"` | `{ id: "weekly-<display name>", kind: "weekly", lengthSec: 604800, scope: { model, models? } }` |

`usedPercent` is the row's `percent`, capped at 100; `resetAt` is `resets_at` normalised to the snapshot's UTC-with-milliseconds form. **The lengths are the kinds' own and the payload states neither**, which is why they are written in the adapter once — ADR-004 requires `lengthSec` on every window, and an adapter that cannot state a length reports no window.

A `weekly_scoped` row names its model by **display name**, and the adapter resolves that name into ids — `scope.models` — because the resolver matches by exact id and infers no family. **The table is the driver's** (`MODEL_SCOPE_IDS` in `lib/driver-claude.js`) and reaches the adapter as an argument, beside the inventory and for the same reason: it is one more reading of the dictionary the driver owns, and a copy inside the adapter would go on naming an id nobody points at after a repin — silently, because a scope resolving to a stale id binds no row and prints no complaint. The suite checks the two halves against each other.

Today it maps `Fable` → `claude-fable-5`, `Opus` → `claude-opus-5`, `Sonnet` → `claude-sonnet-5`, and all three are ids the catalog rates since PB-29. The id of `fable` lags the model the newest builds run — see PB-34 — and the table follows the catalog rather than the newest build, because a scope naming an id no tuple carries binds nothing.

**A name the table does not carry arrives with no `models`**: the window stays in the snapshot, is printed for a person, and binds nothing (ADR-004).

**`is_active` on a row does not become a window field, and that is not an oversight.** It marks the limit that binds right now, which is a question the snapshot does not ask an adapter: every window is carried, ADR-003 takes `remaining` as the largest `usedPercent` over the applicable windows, and ADR-004 names the binding window per candidate tuple. A flag saying which row binds the account as a whole would be a second, coarser answer to a question two consumers already answer per tuple.

It is read in **one** place, and there it is the whole difference: a row at 100 % that the harness marks `is_active: false` does **not** exhaust the account. The limit is not being enforced, and reading it as `exhausted` would take every Claude tuple out of routing on a number nothing is applying. `locked_reason` is not qualified by the flag — it is a state rather than a moment, and an inactive locked row is still locked.

The verdict, by what was found:

| Found | Verdict |
|---|---|
| no binary | `unavailable` / `binary_missing` |
| `loggedIn: false` | `unavailable` / `not_authenticated` |
| the auth answer cannot be read — an older build with no `auth` subcommand, a moved shape, empty output | `unknown` / `quota_unknown`, and the message says auth could not be verified |
| the auth check was killed by the adapter's own deadline, or `ETIMEDOUT` | `unknown` / `probe_timeout` |
| the auth check was killed by a signal the adapter did not send | `unknown` / `probe_failed`, naming the signal |
| the auth check would not run at all | `unknown` / `probe_failed` |
| logged in, no credential record — the keychain refused, the item is absent, the file is absent | `unknown` / `quota_unknown`, with `version` and `models`, and no tier |
| logged in, the stored token is past `expiresAt` | `unknown` / `quota_unknown`, with the tier; no request is made |
| the usage endpoint answered 401 or 403 | `unavailable` / `not_authenticated` — the binary says logged in and the endpoint refuses the credentials it holds |
| the usage endpoint did not answer inside the budget | `unknown` / `probe_timeout` |
| the usage endpoint could not be reached at all | `unknown` / `probe_failed` |
| the usage endpoint answered any other status, or a body that is not JSON | `unknown` / `quota_unknown`, with the tier |
| the usage endpoint answered 200 and named no row this adapter places | `unknown` / `quota_unknown`, with the tier |
| a `session` or `weekly_all` row at 100 % that is not marked `is_active: false`, or one carrying `locked_reason`, **with** a `resets_at` | `exhausted` / `subscription_exhausted`, carrying that reset — the entry expires by itself when it comes |
| the same row **without** a `resets_at` — the likeliest shape of a `locked_reason` | `exhausted` / `subscription_exhausted` with `resetAt: null`, which is **sticky**: neither time nor a later probe lifts it, and the message says so and names `promptobus models --clear-exhausted claude` |
| 200 with windows | `available`, reason `null`, with `version`, `models`, `tier` and `windows` |

**`available` is reachable since ADR-004, and the word still means auth, model *and* limit confirmed.** ADR-003 recorded an assumption — this harness exposes no remaining limit — and the spike of 2026-09-06 disproved it; what has not changed is the rule under it, that an adapter which *cannot* obtain a limit answers `unknown` rather than modelling a value. So every branch above where the limit could not be read is still `unknown` / `quota_unknown` with no `windows`, which the resolver penalises with `unknown-availability` (−10, the limit counted as a neutral 50 %) and reports as the `unknown-remaining` warning — never a block. An unreadable answer is not `not_authenticated`: a guessed logout would take every tuple of the harness out of routing on no evidence.

**A spent model scope does not exhaust the harness.** `exhausted` is a statement about the account — it takes every tuple on it out of routing — and a `weekly_scoped` row at 100 % says one model family is spent while the rest of the account runs. That fact travels as the window's own `usedPercent`, which is where the resolver reads it per tuple as the binding window (ADR-004). Only a `session` or `weekly_all` row spends the harness.

**The two calls that leave the process are parameters, not imports.** `claudeAvailability(models, scopeIds, deps)` defaults them to the live keychain read and the live `fetch`, and the driver declares the adapter with its two dictionaries and no `deps` at all; the suite hands in its own, so no test asks a developer's keychain for a token or reaches api.anthropic.com. The seam is the one the harness binaries already use — the Codex adapter takes its launch context the same way. **A live run may show the system's keychain-permission dialog once**, the first time a process that is not Claude Code asks for that item; the answer is the person's to give and this package cannot pre-empt it.

`timeoutMs` is what is left of the preflight budget once the binaries are resolved, and the adapter takes its deadline from it on its first line. The resolve itself is no longer this adapter's: the workspace host runs `--version` inside `resolveToolBin` with a ceiling of its own, and that call is synchronous, so it is made once by the preflight, outside the race.

**The auth check is spawned asynchronously**, and that is a requirement rather than a style — the contract's "a probe must not block the event loop", from this adapter's side. The adapter kills its own child when its deadline passes, and only that kill is `probe_timeout`: a signal it did not send is `probe_failed` naming the signal, because a harness that dies on every probe must not hide behind a code that reads as "the machine was busy".

**The late-start hook.** A lift that fails on a spent limit is classified by the driver's own `LIMIT_DETAIL` pattern — the same one that reads a live session's stall, because a limit refusal reads alike whether the session wrote it after a turn or the binary wrote it instead of starting. Which half of that pattern matched chooses the code: the harness saying the limit **resets** makes the exhaustion the subscription's, `subscription_exhausted`; a refusal that explains nothing is `manual_exhaustion`.

**Both are written with `resetAt: null`, and both are therefore sticky.** No reset time is parsed out of that text — the harness names one in a person's words and a person's timezone ("resets 3pm"), and a timestamp read out of that would be invented rather than measured. An exhaustion that expires at a made-up moment is worse than one that waits for a person: it lifts itself, and nobody learns the account was out. So `--clear-exhausted` is the only door for both, which is what the reason codes above mean by it, and `subscription_exhausted` here names the limit's owner rather than a known reset.

The mark goes through `markExhausted` with its reason **stated** rather than derived: the helper's own derivation reads `resetAt` alone and could not say "the subscription named a reset this driver refuses to parse". One fact, one door into the cache.

**The lift refusal names the mark.** A mark nothing announced would leave a person with a state they never saw: the file is not one anybody opens by habit, and neither time nor a later probe lifts this entry. The hook returns a line, and the lift appends it: the harness, the cache file it was written to, that the mark does not lift itself, and the two ways out — `promptobus models --clear-exhausted claude`, or deleting the entry by hand. The hook is handed down to the launcher rather than called by a caller catching the refusal: the lift ends the process, and past that line there is nobody left to classify anything. A cache write that fails adds no line and is otherwise swallowed — the person is about to read why their participant did not start, and that diagnosis must not be lost to it.

### Codex availability

The Codex adapter (`lib/model-routing/adapter-codex.js`, carried by the driver as `availability`). It opens a fresh `codex app-server --stdio` under the same isolated environment a lift uses (`sessionEnv`, which drops `CODEX_HOME`), sends `initialize`, asks two questions, and kills the process. **It never sends `thread/start` and never starts a turn** — a preflight that cost a thread would cost what it exists to save, and the suite asserts the stub's thread directory is still empty after every probe.

Codex gates a lift on the limit twice, and the two gates are meant to stay two. This one asks about the ACCOUNT before a harness is chosen; the refusal in `lib/codex-session.js` still stands where it always did, inside the lift. What they share is the reading of the protocol — `rateLimitReached` and `listedModels` — not a copy of it.

**Where the limit comes from.** `account/rateLimits/read` is a request that answers at once, with no thread. Measured on codex-cli 0.146.0: the `account/rateLimits/updated` notification the lift waits for does **not** arrive after `initialize` alone — waits of 10 s and 30 s on a live account saw only `remoteControl/status/changed` — so a probe built on the notification alone would report no window, ever. The bounded wait for the notification is kept as the path for a binary that does not have the request: an error saying serde's `unknown variant` is a missing method and sends the probe there, and every other refusal of that call is the one a logged-out account gives.

**What it never asks.** `getAuthStatus` would be a crisper auth signal and answers `{ authMethod, authToken, requiresOpenaiAuth }` — it hands back a **token**, and `message` is the one free-text field of this module that reaches disk. `account/read` answers the account **e-mail** beside the plan. Neither is called, and neither should be added.

That rule survived PB-28, and it is why the tier is read where it is. PB-28's own text names `account/read` as the source of `planType` — and the same field is already inside the answer to `account/rateLimits/read`, which this probe makes anyway. So the tier comes off the call already being made, and the call that would hand over an address is still not made at all: one fewer request, and one fewer thing that could put an identity in front of the module whose job is to keep one off the disk.

**Stderr is not a channel.** app-server writes ``ERROR codex_models_manager::cache: failed to load models cache: missing field `base_instructions` `` on a perfectly healthy start and answers everything correctly afterwards. The child is given no stderr pipe at all, so there is nothing to misread.

What the answers become:

| What app-server said | Verdict |
|---|---|
| the preflight resolved no `codex` binary — the host has no `resolveToolBin`, or its call threw | `unknown` / `probe_failed` |
| the host says there is no such binary | `unavailable` / `binary_missing` |
| the host says there is one and app-server does not start | `unknown` / `probe_failed` — the shipped standalone host answers `{ ok: true }` for any name, so a machine without `codex` arrives here rather than at `binary_missing` |
| the limit read refuses, and not for a missing method | `unavailable` / `not_authenticated` |
| a snapshot with `rateLimitReached` — a named `rateLimitReachedType`, or a window at 100 % | `exhausted` / `subscription_exhausted`, `resetAt` from the window that was reached |
| a snapshot with room left | `available`, with `windows` and `models` |
| no snapshot from the request and none from the notification | `unknown` / `quota_unknown` — "no notification" has never been a refusal, and `unknown` is penalised by the resolver rather than blocking |
| app-server did not answer inside the budget | `unknown` / `probe_timeout` |
| app-server exited, refused `initialize`, lost the channel, or the probe itself broke | `unknown` / `probe_failed`, each with its own wording — a budget that ran out and a pipe that died ask a person for different things |

**Windows** are `primary` and `secondary`, under the names the payload gives them: `usedPercent` as it stands, `lengthSec` from `windowDurationMins` × 60, and `resetAt` from `resetsAt` — unix **seconds** on the request, an ISO string on the notification, and `null` when it is neither. Nothing is renamed into hours and days: the length is a number the harness states, and a label invented from it would be a second, quieter claim about the same fact. A snapshot that names no window but carries the numbers at its own top level is ONE window and it is `primary` — that is not an invention either: `rateLimitReached` counts the snapshot itself among the windows it checks and `rateLimitNote` reads `snap.usedPercent`, so the flat form has always been the primary window written without its name, and reading it as "no window" would publish a spent limit as an exhaustion with no reset — the sticky kind — over a limit the harness had timed. A `resetsAt` outside the range a timestamp can have (milliseconds handed over where seconds were meant) is `null` rather than a value divided by a thousand: the repaired one would validate and be a time nothing said. The range check and the formatting are shared with the other two adapters (`stampAtMs` in `lib/model-routing/cache.js`); the UNIT stays here, because that is where the evidence for it is.

`kind` and `scope` are stated rather than derived: `primary` is the `session` window and `secondary` the `weekly` one, neither binds a model, so the scope is `null` — the account. **A window whose `windowDurationMins` the payload does not state is left out**, because ADR-004 requires a length and a pace cannot be computed without one.

**What the account says about itself beside its windows** (PB-28), all of it informational — nothing scores it and nothing acts on it:

| Field | Where it comes from | What is carried |
|---|---|---|
| `tier` | `planType`, inside the limits answer | `{ name: planType, source: "probe" }` — `source` is one of ADR-004's four, not the name of a method |
| `credits` | `credits { hasCredits, unlimited, balance }` | two booleans, `{ available, unlimited }`. The **balance is read and never carried**: an account with credits and no flag still has them, and a count is a fact about the account rather than about the plan |
| `resetCredits` | `rateLimitResetCredits.availableCount`, at the **top level** of the answer rather than inside `rateLimits` | `{ available: <count> }` — the "Full reset (Weekly + 5 hr)" credits a person may spend by hand. **The adapter never spends one**: ADR-004 puts that among the things not in v1, being money-adjacent and a person's decision |
| `spendControlReached` | the same snapshot | the boolean, and the message names it **only when it is true** — "the spend control is not at its ceiling" is not news |

The reset-credit count is in the verdict message as well as in the field, and the exhausted branch carries all four: an account with two unused resets beside a spent window is exactly where a person wants to be told.

All four are read from **whatever carried the snapshot**, and on the notification fallback that is less: the shape the suite's stand-in models carries a `planType` and neither a `credits` block nor `rateLimitResetCredits`, so a field the notification omits is simply absent there. What a real notification payload contains was not measured by the spike of 2026-09-06 and is the open question PB-24.1 asks — the same question it asks about the window duration, and this is a second reason to answer it.

**Models** come from `model/list`, which answers after `initialize` alone. The ones app-server marks `hidden` are **kept, with `hidden: true` on them** (ADR-004, PB-28) — they used to be dropped. The reasoning for dropping them was sound and is now applied one floor down: the resolver's inventory is the rows *without* the mark, so a tuple naming a hidden model still comes out as `model-not-in-inventory` and needs no code of its own. What dropping them cost was the other half — `promptobus models` showed an inventory that did not match what the harness itself lists, and `models validate` could only call a hidden row *missing* where the honest answer is that it is hidden. On the measured account the hidden rows are `gpt-reserve` and `codex-auto-review`. The mark is written only where it is true: the absent case and an explicit `false` are one fact.

No `flags` are attached — Codex prints no mark on a listed model that means anything to a policy. A `model/list` that refuses costs the inventory and nothing else; the limit verdict still stands. An adapter publishes what the account exposes, and matching that against a named model is the resolver's question and the lift's refusal, not the preflight's — which is why the snapshot vocabulary has no code for it at all.

**What the rows carry and this package does not.** `model/list` also answers `supportedReasoningEfforts` per row — `ultra` above `max` on the sol and terra families — and `additionalSpeedTiers: ["fast"]` beside `serviceTiers`. PB-28 asked for both to be recorded, and **they are not**: the snapshot's model object is closed to `model`, `rated`, `hidden` and `flags`, and ADR-004 says in as many words that the service tier "is not an effort and is not modelled in v1 at all". Widening the object is an ADR pass rather than a schema edit, and PB-24.2 puts that question to the owner. Nothing is blocked meanwhile: the catalog took the effort ladders from the spike document, not from a snapshot.

**The budget** is the preflight's whole `timeoutMs`, spent as a deadline rather than divided: each request is capped by the smaller of its own ceiling (`INIT_TIMEOUT_MS`, `LIMIT_READ_TIMEOUT_MS`, `MODEL_LIST_TIMEOUT_MS`) and what is left of it, and the notification fallback by the smaller of `limitWaitMs()` and the same remainder. An app-server that dies is not waited for at all — it answers `probe_failed` at once instead of holding a budget three harnesses are sharing.

### Cursor

Implemented (PB-16, extended by PB-27). The adapter is `lib/model-routing/adapter-cursor.js`, declared by `lib/driver-cursor.js` as its `availability`. It runs two commands on the binary the preflight resolved — `status` for auth, `models` for the inventory — and then makes one call the binary itself does not: `POST <backendUrl>/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, the dashboard's own method, answered with the CLI's token. It starts no session, writes nothing, and never touches the persist/tmux path: an adapter answers about the account, before any session exists.

| What the probe sees | Verdict |
|---|---|
| the preflight resolved nothing — the host has no `resolveToolBin`, or its call threw | `unknown` / `probe_failed` |
| the host says there is no such binary, or the one it named is gone | `unavailable` / `binary_missing` |
| the binary is there and will not run — no permission, an argument the platform cannot carry | `unknown` / `probe_failed` |
| either command outlives what is left of the budget | `unknown` / `probe_timeout` |
| `status` says the account is not logged in | `unavailable` / `not_authenticated` |
| `status` says neither thing, whatever its exit code | `unknown` / `probe_failed` |
| logged in, but the listing refused or came back unreadable | `unknown` / `probe_failed` |
| logged in, and no access token could be read from the keychain or the environment | `unknown` / `quota_unknown`, with `models` and `version` |
| the usage call answered 401 or 403 on the **keychain** token | `unavailable` / `not_authenticated` — that credential is the measured one, so a refusal is a statement about the account |
| the usage call answered 401 or 403 on a **`CURSOR_API_KEY`** token | `unknown` / `quota_unknown` — that path is not measured, so a refusal says only that the limit could not be read |
| the usage call did not answer inside the budget | `unknown` / `probe_timeout` |
| the usage call could not be reached at all | `unknown` / `probe_failed` |
| the usage call answered any other status, or a body that is not JSON | `unknown` / `quota_unknown` |
| the usage call answered 200 and named no billing cycle that reads | `unknown` / `quota_unknown`, with the tier |
| **both** pool windows read and both at or past 100 % | `exhausted` / `subscription_exhausted`, resetting at the end of the cycle |
| logged in, inventory in hand, the cycle read | `available`, with `models`, `version`, `tier` and two `windows` |

**Where the credential is read from, and what is never asked for.** The macOS keychain generic password `cursor-access-token` **first**, read with `/usr/bin/security find-generic-password -s cursor-access-token -w`, the absolute path for the reason the Claude adapter gives: that is the credential the spike of 2026-09-06 measured `GetCurrentPeriodUsage` answering. `CURSOR_API_KEY` in the environment is the fallback, taken only when the keychain has nothing — the other way the binary authenticates, and **nothing measured says DashboardService accepts an API key at all**, so it is a fallback rather than a claim. Which of the two was used travels with the token, because it decides what a refusal means. **`cursor-refresh-token` is never asked for**: it is the credential that mints new ones, this adapter has no use for it, and the suite checks the source — comments stripped — for the name. The token reaches one `Authorization` header and no verdict, message or cache file.

The backend URL comes from `~/.cursor/cli-config.json`, field `serverConfigCache.backendUrl`, and **only `https:` is accepted** — the value is read off disk and a bearer is about to be sent to it, so a `http:` there would be a token in the clear. Anything else falls back to the measured default `https://api2.cursor.sh`. That file also holds `authInfo` — the account's address, its display name and two ids — and **one field of it is parsed**; the rest is not read, so the cache's promise to hold no address needs no second guard.

**How the answer becomes windows: one cycle, two pools.** `GetCurrentPeriodUsage` carries one window — `billingCycleStart` to `billingCycleEnd`, epoch milliseconds in strings — and two percentages inside it. ADR-004 writes that as two windows of the same length:

| Window | Scope | Used |
|---|---|---|
| `monthly-auto` | `{ pool: "auto", models: [...] }` | `planUsage.autoPercentUsed` |
| `monthly-api` | `{ pool: "api" }` | `planUsage.apiPercentUsed` |

Both are `kind: monthly` with `lengthSec` computed from the cycle the answer states and `resetAt` at its end — **`monthly` is a name and is not thirty days**, and the number is the harness's. `usedPercent` is capped at 100, because `bonusSpend` can carry a total past the included amount and "spent" is what a value past the end of the range means.

**The `auto` pool names inventory ids, and the family inference happens here.** `autoBucketModels` names families — `composer-2.5`, `cursor-grok-4.6` — while the inventory names ids with the effort level and the speed tier baked in (`cursor-grok-4.6-xhigh-fast`). ADR-004 requires a scope that covers models to name them **by id**, because the resolver matches exactly and infers no family, so the adapter — the module holding both lists — does the expansion. Two ways an id joins the pool, and this is the rule: **the id is a bucket name, or it starts with a bucket name followed by a hyphen.** The hyphen is the whole of the second half — without it `vega` would claim `vegabond-3`. A bucket name matching no id contributes nothing, and an empty result means no `auto` window at all rather than a pool with no list: the schema requires the list there, the harness publishes it, and its absence is the adapter's fault rather than a limit to report. **The `api` pool carries no list**, being the complement; a list of everything else is not a fact any harness stated, and the schema refuses one there.

**One spent pool does not exhaust the harness.** A pool at or past 100 % is spent for the tuples it covers, and the resolver reads that per tuple as the binding window (ADR-004). `exhausted` takes every Cursor tuple out of routing, so it is reserved for **both** pool windows having been read and both being spent — which is the whole point of publishing two windows rather than one number. A list of one window is not evidence about the pool missing from it: when the harness published no `autoBucketModels`, only the `api` window is reported, and that window at 100 % says the api pool is spent and nothing about the other one.

`displayMessage` travels on that branch and not on the healthy one. It is written for a person who is out of usage, and beside `available` it reads as a contradiction — "available … the harness says: you've hit your usage limit".

**The tier is derived, and the plan's name is the one question the tool cannot answer.** No Cursor method returns it — the spike checked, and `cursor.com/api/auth/stripe` refuses the CLI's token — so the tier is `{ name: "included:<cents>", source: "derived" }` from `planUsage.limit`, the PLAN's included amount and never the account's spend. An answer that names no amount carries **no tier**: `included:0` would be a plan nobody stated, read as measured. A person who wants the plan's name writes it into the `user` overlay under `account.cursor.plan`, and it is display only; **no command writes it** (ADR-004).

**A token that could not be read is `quota_unknown`, not `not_authenticated`.** PB-27's text says `not_authenticated` there; this follows ADR-004's own reading of the word instead. `status` has already answered the auth question and the binary has just listed 210 models, so the account is fine — what failed is reading the bearer for a second channel, and calling that a logged-out account would take every Cursor tuple out of routing on a keychain dialog somebody dismissed. A **401 or 403 from the usage call** is `not_authenticated`, because a refused token is a statement about the account rather than about the request.

**The near-limit nudge is rewritten, never quoted.** `GetUsageLimitStatusAndActiveGrants` is asked last and is optional — a refusal, a timeout or an empty budget costs the note and nothing else, and the windows are the fact. When it carries `thirdPartyUsageNudge`, its `threshold` and its `targetModel` become a sentence this adapter writes; the nudge's own `label` is prose for a dialog and does not travel, and a nudge with no numeric threshold is no nudge — "past 0 %" would be a warning about nothing. `displayMessage` from the usage answer is the one piece of harness prose allowed into a `message` — on the exhausted branch only, per the paragraph above — and it is bounded rather than trusted: control characters out, whitespace collapsed, 120 characters, and a string containing `@` refused outright, the shape of an address being the one thing the cache promises never to hold.

**The keychain read and the two POSTs are parameters, not imports.** `cursorAvailability(tool, deps)` defaults them to the live implementations and the driver declares the adapter with no `deps`; the suite hands in its own, so no test asks a developer's keychain for a token or reaches api2.cursor.sh. A live run may show the macOS keychain-permission dialog once, the first time a process that is not `cursor-agent` asks for that item.

**A slow binary is a timeout, never an unavailable account.** `timeoutMs` is what is left of the preflight budget and every call shares it: what remains is the ceiling of the next one, and a binary still running when it ends is killed. The binary was resolved before the probe started, so the ceiling a host spends inside `resolveToolBin` is already out of this adapter's way. A launch that fails outright is `probe_failed` rather than a timeout: a binary that never started did not fail to answer in time. Calling a slow `cursor-agent` `unavailable` would drop every Cursor tuple out of a run on a machine where the account is perfectly fine.

**What the parse relies on**, measured on `cursor-agent` 2026.09.02-c22c1a3 (2026-09-05). Both commands colour their output even when stdout is not a terminal, so ANSI is stripped before anything is looked at. `status` answers `✓ Logged in as <account>` and exits 0 in both the signed-in and the signed-out case, so **the text is the answer and the exit code is never consulted** — a non-zero code beside a line the adapter can read says nothing about the login. The signed-out line is matched separately, because "not logged in" contains "logged in". Output that says neither thing is a third answer rather than a second: it is `probe_failed`, because calling it a logged-out account would send the person to `cursor-agent login` for a parse fault and cost them the real diagnosis. `models` answers a header line, `<id> - <Display Name>` rows — about 210 of them, `auto` first — and a trailing `Tip:` line, so a row is recognised by the shape of its id next to a literal ` - `, not by being a line with two fields in it. **The model id is taken whole, effort suffix included**: in Cursor the effort level is a flat suffix of the id (`claude-opus-5-thinking-max`, `cursor-grok-4.6-xhigh-fast`) and not a separate flag, so a stripped suffix would name a model the binary does not have.

A `(NO ZDR)` mark on a row travels as `flags: ['no-zdr']` on that model and **is not judged here**. The package carries what the harness said; a consumer that must not use a model outside zero-data-retention denies it in an overlay, and it can only do that if the mark arrived.

A listing that refused, or one nothing in it parses, is `probe_failed` rather than an inventory of none. Every account with a subscription lists about 210 models, so an empty result is a parse fault, and reporting it as an empty inventory would exclude every Cursor tuple as `model-not-in-inventory` and send the person to the catalog for a fault that is not there.

`version` is whatever the host read while resolving the binary; nothing is asked for it, because resolve already runs `--version` and the driver reads the same field at option refuse. A host that reports none leaves the field out.

Nothing the binary printed reaches `message`. `status` prints the account address on the one line the adapter reads, and the adapter counts and classifies instead of quoting.

**Late-start classification is not implemented for Cursor, and the gap is deliberate.** The other harnesses hand `markExhausted` a limit their start path named; Cursor's start path names nothing. The only text `spawn` gets back from a failed lift is a string the package itself composes, and the driver says so in its own words next to the `failed` stall route — *a wrong model id and an expired Cursor login look the same*. Hooking a mark to it would fire a sticky `manual_exhaustion` — which only `--clear-exhausted` lifts — on a typo in `--model`. So a Cursor limit hit at start is not marked in the cache today, and the follow-up finding on PB-16 carries the two candidate routes to a real signal.

### Resolver

A library, like the two subsections above it: `promptobus models` prints what it answers, and `--strategy` on `spawn` and `review` lifts on it. Two entry points, both in `lib/model-routing/`:

| Call | What it answers |
|---|---|
| `resolve({ role, strategy, constraints, policy, snapshot, liveParticipants, now })` | one decision, valid against `schemas/model-routing/decision.schema.json`. `policy` is the answer of `loadCatalog`, `snapshot` the answer of `preflight`, `constraints` the caller's `--harness`, `--model`, `--effort` and `--allow-payg`, `liveParticipants` the participants already up as `{ harness, model, role }`, and `now` a clock in milliseconds whose only product is `snapshot.ageSec` |
| `render(decision)` | that decision as the text `models` prints. It reads the document and nothing else, so the two outputs of one command cannot drift |

Both are pure — no disk, no harness, no clock of their own — because determinism is the contract: the same inputs give the same tuple whatever order they arrive in.

**Filtering**, in [ADR-003](../adr/adr-003-model-routing.md)'s order, and the first step that matches is the reason reported:

1. the tuples of the merged catalog;
2. the allow and deny lists **in force for the role being routed** — the unscoped ones with that role's `byRole` block unioned into the deny and intersected into the allow — then `--harness`, `--model` and `--effort`: `denied-by-policy`, whose `detail` names the rule and every layer that wrote it, then `constraint-mismatch`. Allow lists of different selector kinds hold at once: a tuple must be named by every allow list there is, and the first one that does not name it is the one reported. The `flags` selector is the one that is not applied here — it needs a snapshot row, and it runs at step 4a;
3. tuples not rated for the role — `role-not-allowed`;
4. tuples whose model the account does not expose — `model-not-in-inventory`. A harness that reported no inventory at all excludes nothing: silence is not absence;
   4a. the `flags` selector, over the marks the snapshot carries on the model row this step just consulted — `denied-by-policy` again, with the flag and its layers in `detail`;
5. `unavailable` and `exhausted` harnesses — `harness-unavailable`, `harness-exhausted`;
6. pay-as-you-go without `--allow-payg` — `payg-not-allowed`;
7. scoring;
8. the reviewer rules;
9. the tie-break.

**A harness the snapshot does not carry is filtered out, not excluded.** The preflight is asked about the harnesses the workspace declared, so the snapshot's harness set is that declaration, and ADR-003 says the catalog is filtered by it. On a workspace that declares only `claude`, the Cursor and Codex tuples are absent from `candidates` rather than listed with a reason — they were never considered, and the exclusion list has no code that would be true of them. The cost is that `resolve` alone cannot tell "you named a harness this workspace never declared" from "nothing survived filtering": both end with `chosen: null`. Telling them apart is the command's job and it happens before the call — an explicit `--harness`, `--model` or `--effort` that matches no tuple of the merged catalog is `constraint-unknown`, and a `--clear-exhausted` naming an undeclared harness is `harness-unknown`, both from the table above.

**Scoring** is the weight table of the merged policy over four values. `quality` and `speed` are 1–5 ratings normalised as `(r − 1) / 4 × 100`; `quotaCost` is inverted, `(5 − r) / 4 × 100`, so a smaller spend contributes more; `remaining` is not a rating but `100 − max(usedPercent)` over the **applicable windows of that tuple** — the account-wide ones plus the scope covering it. A tuple's `roleRatings` override its ratings for the role being routed. A component is its weight over 100 times that value, and all four are published, so a reader can divide one back by its weight and recover the input.

`remaining` is therefore per tuple rather than per harness, under every strategy: two Cursor tuples on one snapshot differ when their pools do, and one in a spent pool scores below one in a pool with room. [ADR-004](../adr/adr-004-subscription-balance.md) calls this a refinement of ADR-003's own sentence and not a reversal of it — that sentence already said "applicable", and until the snapshot carried scopes a harness had only account-wide windows.

A harness that is `unknown`, or for which no window applies, has no remaining limit to read: it counts as a neutral 50 % and the candidate loses the `unknown-availability` points. Penalised, never blocked — that is the fourth row of the ADR's decision table.

**Hidden rows are not inventory.** A model the harness lists and declines to offer carries `hidden: true`, and the resolver's inventory is the rows without it. So a catalog tuple naming a hidden model is excluded as `model-not-in-inventory` — which is true of it from the resolver's side — and a hidden unrated row is not a `runtime` row either: it is not something a person could pick.

**The extra rules** are the ADR's, and every number in them comes from the merged policy, so an overlay moves it: `live-participant` costs points for each participant already up on that harness and is capped; `reviewer-diversity` adds points to a reviewer whose harness or model differs from every live worker's — with no live worker there is nothing to differ from and no bonus; and a quality floor is a **choice rule, not a filter**. ADR-004 gives **both** roles one, `qualityFloor: { worker: 3, reviewer: 5 }`, superseding ADR-003's reviewer floor of 4 and its absence of a worker floor; `reviewerQualityFloor` is still read as an alias for `qualityFloor.reviewer`, a layer stating both is a `quality-floor-alias` warning and the explicit key wins. A candidate below its floor keeps its place in the list with its score, and only the pick moves past it; when nothing reaches it the best remaining candidate is taken with a `reviewer-floor-not-met` or `worker-floor-not-met` warning rather than the run refusing.

### `balance`: which account to spend from

The fifth strategy, and it answers a different question from the other four — not how to weigh the qualities of a tuple, but which of the person's subscriptions to spend. It has **no weight set of its own**: inside one harness it orders tuples by the merged `balanced` weights, which is what "the role's ordering" means throughout [ADR-004](../adr/adr-004-subscription-balance.md). The cost is named rather than hidden — an overlay that re-weights `balanced` re-weights the inside of `balance` with it.

It is a **choice layer above the scoring, not a filter**. Filtering steps 1–6 run unchanged, every surviving candidate is scored and keeps its place, and each gains a **pace block**:

| Field | What it is |
|---|---|
| `window` | the **binding window**: the applicable one with the highest `usedPercent`, by `id`, `kind` and `scope`. Applicable means the account-wide windows plus the scope covering this tuple, so two tuples of one harness can bind different windows |
| `usedShare` | `usedPercent / 100` — a share, 0…1 |
| `elapsedShare` | `(now − (resetAt − lengthSec)) / lengthSec`, clamped to 0…1 against clock skew — a share |
| `underspend` | `(elapsedShare − usedShare) × 100` — **percentage points of that window**. Positive means the account is behind the pace of its own window and has room |
| `spendPenalty` | `balance.spendUnit × (quotaCost − 1) / 4`, in the same points |
| `effective` | `underspend − spendPenalty` |
| `eligible` | whether this candidate takes part in the comparison, with a `note` when it does not: `no-pace` or `window-spent`. Every other field is `null` when it could not be computed, in both cases |
| `representative` | present and `true` on the one candidate that represents its harness — the tuple that would actually be picked there. Named in the document so the text output marks the same row the pick was made on rather than re-deriving the rule |

**One unit, and it is stated once.** The two inputs are shares of 0…1; everything compared — `underspend`, `spendPenalty`, `effective`, `balance.band`, `balance.spendUnit` — is in percentage points of the window, which is the unit `usedPercent` is already in. The `× 100` is the whole conversion and both shares are published beside the result, so a reader can recompute it. Mixing the two is not a rounding difference but a degenerate strategy: read as shares, every harness would fall inside one band and `balance` would quietly be `balanced`.

A window whose `resetAt` is absent or is not in the future **is not paced** — the fact has expired, and the sixty-second TTL is what repairs it. A binding window at or past 100 % is `window-spent`. A harness with no applicable window has no pace, and the decision says so rather than guessing one.

**The pick**, in order:

1. among **eligible** candidates, each harness is represented by its best tuple by the role's ordering that meets the role's quality floor — the tuple that would actually be picked on it, so the pace compared is the pace of the tuple the comparison is about;
2. the largest `effective` leads, and every harness within `balance.band` of it is tied with it. The band is measured from the leader's **number**, which is what makes the tied set well defined whatever order the candidates arrived in;
3. inside the tied set the `balanced` score of each representative decides, then ADR-003's own tie-break;
4. **no eligible candidate — the pick is the best `balanced` score**, with the `balance-fallback` warning. A fallback rather than a refusal, because a person asked for work to start and not for a lecture about their windows.

Two overlay keys carry the numbers and both default to **5** — five percentage points of a window. `balance.band` says "these two accounts are about equally spent, so take the better model"; its job is not to model noise, but the noise floor is about a point, so a band below that would do nothing. `balance.spendUnit` is equal to it by default, so a `quotaCost` of 5 gives up exactly one band against a `quotaCost` of 1: the heaviest tuple has to be a whole band ahead on pace to win.

**`remaining` and pace are not the same fact counted twice.** `remaining` is a level — how much of the window is gone — and it ranks tuples inside a harness. Pace is a rate — how much is gone against how much of the window has elapsed. A harness at ninety per cent used with ninety-five per cent of its window elapsed is high on level and *ahead* on pace, and the two components say so independently.

`models` prints the pace table under the candidates, one row per harness with the representative the document names, the binding window, both shares, the underspend, the penalty and the effective number; `--json` carries the same numbers on every scored candidate. Neither appears under the other four strategies: a decision carrying a number no rule of its own strategy used would invite a reader to believe one did. **Nothing in this package pins the reviewer to a harness** — a reviewer is routed by pace like a worker, with the floor of 5 and the diversity bonus above it.

**The tie-break** is effective score, then confirmed availability, then canonical priority, then the tuple id. It is total, because two tuples cannot share an id — which is why a duplicate id is an error in `models validate` and not a warning.

The decision reports what the caller pinned in `constraints`, and `applied` there is literal: it is true when a named value actually narrowed the list, so `--harness claude` against a claude-only catalog reports `false`. Warnings taken from the merge are copied with their `code` and `message` and nothing else; `unknown-remaining`, `snapshot-stale` and `probe-incomplete` are the resolver's own and are raised once per harness whose candidates were scored.

The pair `test/fixtures/model-routing/decision.json` and `models.txt` is reproduced from `catalog.json` and `snapshot.json` twice, and the two runs are not a duplicate of each other: `test/model-routing-resolver.test.mjs` calls the pure function with synthetic paths, and `test/model-routing.test.mjs` runs the `models` command itself against a real host and substitutes the paths that run actually has. Both compare the JSON after the normalisation [its README](../../test/fixtures/model-routing/README.md) states, and the text byte for byte.

### Participant telemetry

The catalog's ratings come from published benchmarks, and two frontier models a point apart on one leaderboard share a band; nothing else in the tool learns from what actually happens on this machine. So `promptobus done` appends one record per participant to `telemetry.jsonl`, JSON Lines, beside the availability cache the host names ([02-host](02-host.md)), mode `0600`. This is the collecting half only: nothing here scores, compares or proposes anything, and reading the records back — a finer scale, absolute bands, a calibration pass — is the next series.

**Local, and only local.** Nothing sends the file anywhere, no command reads it but the count line of `models`, and the tool never rotates it.

**Who gets a record.** Every participant that lifted a session: role `worker` or `reviewer`, with a model on its record. A participant WITHOUT a routing decision gets one too — a legacy lift or an explicit `--model` — with `strategy: null`, so a hand-picked tuple is measured beside a routed one. The task owner gets none: it has no session and no tuple. Neither does an address that only ever wrote to the task, the already-dismissed record `promptobus send` writes for a foreign session.

**When.** At `done`, and not at `dismiss`. A dismissal is not the end of a participant — a new assignment to the same address puts it back under watch — so a record per dismissal would put several rows on one participant's run with nothing to merge them by, and the file is append-only. `done` is the one moment a run is over for good, and `dismissedBeforeDone` carries the dismissal into that single row.

| Field | What it holds |
|---|---|
| `schemaVersion`, `recordedAt` | the record version, and when `done` wrote it |
| `task` | an opaque local key made from the task id, so records of one run group together. The slug a person typed is not in the file. It is unsalted so the grouping holds across installs of one account, which makes it a key rather than a secret — someone holding this file and the workspace could match one back to an id they already have |
| `role`, `harness`, `model`, `effort` | what actually ran |
| `tuple`, `strategy`, `strategySource` | the routed pick, or `null` three times for an unrouted one |
| `spawnedAt`, `endedAt`, `durationSec` | the lift, the participant's own end — its dismissal, otherwise the close — and the seconds between them |
| `turns`, `reviewRounds`, `questions`, `resultCount` | the bus traffic: messages it sent, `review` messages it received, and the `question` and `result` messages among the ones it sent. Counted from the canonical message records, not from `history/`, which holds only what a mailbox fetched |
| `windows` | one entry per limit window that applied to the tuple at spawn — `{ id, kind, scope, usedPercentAtSpawn, usedPercentAtEnd }` |
| `concurrentParticipants` | how many other participants of the task were live on the same harness when this one spawned |
| `dismissedBeforeDone` | whether the participant was dismissed from watch before the task closed |

**The window delta is the evidence `quotaCost` never had.** A positive `usedPercentAtEnd − usedPercentAtSpawn` on the tuple's binding window is what that run spent, in the account's own unit rather than in money or in a rating. The spawn reading comes from the decision: a routed lift records `windows` on its participant — the applicable windows of the chosen tuple, the account-wide ones plus the scope covering the model, with the `usedPercent` they had at that moment ([Resolver](#resolver)). An unrouted lift records none, and its `windows` is empty rather than filled with something else. The end reading comes from the availability cache as it stands at the close, and **only while its entry may still be used**: past the TTL it is `null`, because a delta measured against an hour-old percentage is not a delta.

**`done` does not probe, so the end reading is only as fresh as the cache.** The window TTL is sixty seconds and nothing in the close asks a harness anything — a probe inside `done` would put the preflight budget on the path that closes a run, and whether to pay it is a decision the calibration pass gets to make. Until then the rule for a person or an orchestrating agent is one line: **run `promptobus models --refresh` right before `promptobus done` to record the end value; otherwise the record carries the start value only.**

**The delta belongs to the run, not to one participant.** Several participants of one account overlap in time, and a weekly window that moved four points while three of them worked does not say which of the three spent them. `concurrentParticipants` is that fact stated in the record rather than left to be guessed; how to divide it is the calibration pass's decision, not this file's.

**What a record never holds.** No prompt text and no message body, no repository path, worktree or branch, no session id, no email, no token. The record passes the same publicity rule as the cache and for a sharper reason: it is assembled from a participant journal and a task journal, which hold every one of those. So it is projected field by field onto the closed shape above — nothing is spread into it — and the schema's objects are closed, so a document carrying such a field stops validating. The only identifier is `task`, and it is a digest.

The terms this section introduces — participant telemetry, telemetry record, window delta — are added to [the glossary](../GLOSSARY.md) by the release task of this series (PB-33), together with the rest of ADR-004's vocabulary.

**Growth and clearing.** One line per participant, a few hundred bytes each: a run of three participants a day is on the order of a megabyte a decade. `promptobus models` prints the count and the size so the number is visible without opening the file. There is no rotation and no expiry in this version — remove the file with `rm` and the tool starts a new one at the next `done`.

## Status, done, dismiss, history, prune

`status` lists active tasks, participants, unread counts, and warden health. A participant lifted with `--strategy` also gets its routing line — the strategy, the tuple, the score, how old the availability snapshot was when the pick was made, and the warnings — read out of `metadata.routing` ([04-protocol](04-protocol.md)) through the accessor. That record also keeps `windows`: the applicable windows of the chosen tuple with the `usedPercent` they had at the lift, which is the starting value a later reader needs to say what the run spent. It is the resolver's own applicable set, and it is empty when the harness reported no window. The strategy envelope agreed before a run is therefore auditable during it, not only at its start.

A Cursor participant's liveness is judged by **three** signals, and a stall verdict needs all three quiet: the chat transcript growing, an instrumental process under the session's tmux pane, and a write in the participant's own worktree — the newest mtime among `git ls-files -mo --exclude-standard` plus its HEAD commit time (`lib/cursor-persist.js`). The third exists because the agent edits files inside one long call and spawns nothing, so the first two see a session that is working as one that is silent. It is **positive only**: a recent write lifts the verdict, its absence never raises one, and a session nothing writes for still stalls once the threshold passes. The verdict names each measurement and its span, so a silent transcript can be told from a dead session without opening the panel.

`done` closes the task. The mailbox owner may call it. Sessions the bus started are stopped unless `--keep-sessions`. Journals of tasks closed more than `PRUNE_DEFAULT_DAYS` (14) days ago are removed on that last call.

Right after the close it appends one telemetry record per participant that lifted a session ([Participant telemetry](#participant-telemetry)) — before the sweeps, because the run is over at the close and everything after that line may lawfully end in a warning. A telemetry file that cannot be written is itself a warning and never a refusal: the task is already closed and there is no undo.

It also sweeps the worktrees of every closed task, and a directory goes only when the branch's work is proven to be in the repository's default branch. The judgement is about **content, not ancestry**: a squash merge leaves none of the branch's commits in the base by construction, so the commit count says nothing on its own. Two measurements answer it (`lib/worktree.js`): whether merging the branch into the base would add anything (`git merge-tree --write-tree`), and whether the base holds a commit carrying the branch's own patch (`git patch-id --stable` over `git diff <fork> <branch>`). The second exists because the first stops answering once the base moves over the same lines — which is exactly what the next worker landing on the same file does. Everything else keeps the directory, and the report names the state it measured: `merged as a squash`, `is entirely in <base>`, or `is not merged`. A squash whose content was edited while merging, and work taken as a series of cherry-picks, are not recognised and keep the directory: it is cheap to delete and impossible to return.

`dismiss <address>` drops a finished participant from watch.

`history` prints **read** mail, oldest first. Default limit 50. `--all` drops the limit. It does not mark mail read.

`prune` previews deletions. `--yes` deletes. `--older-than <days>` changes the age.

## Guard and warden

`guard` is the Stop-hook helper. Clean mailbox: exit 0, no output. Unread mail: exit 2, return the turn. Same state twice, then it warns and lets the turn end.

`warden` is the only listener for a task. Any bus command starts it. `PROMPTOBUS_WARDEN=off` disables auto-start. A knock carries at most `KNOCK_TEXT_MAX` (2000) characters of body text (`lib/contract.js`). Only `promptobus_mailbox` marks mail read.

## The Codex holder

A Codex participant is a thread inside a `codex app-server --stdio` process, and stdio is held by whoever opened it. `promptobus spawn` returns after the first turn, so it starts a detached holder (`lib/codex-hold.js`) and leaves; the holder answers approvals and listens on the unix socket the driver writes turns into.

**A holder outlives the command that started it. It does not outlive its session.** Its session record is its identity — the file it was handed and reads on every decision — and it watches for that file every five seconds. Gone means there is nothing left to hold: the holder kills its app-server and exits, without writing to its log, because a log write would recreate the directory tree that was just removed. The record disappears in two ways, and both mean the same thing: `promptobus done` and the driver's `stop` remove it (after reaping the holder, so the watch usually has nothing to do), and so does anyone who removes the tree it lives in.

That last case is the one this exists for. A cleanup hook reaps a holder only where a hook can run, and the take-down that leaks reaches none: measured 2026-09-05, a suite file taken down with SIGKILL leaves its holder and app-server alive, while SIGTERM and a clean finish leave nothing — and SIGKILL is what the suite runner itself uses, at the file timeout and on Ctrl-C alike. One 2026-09-04 run left twelve such processes alive into the next day, each holding a session file under a directory that had since been removed. Nothing but the holder itself was in a position to notice.

## MCP

`promptobus mcp` serves stdio JSON-RPC. It must not write logs to stdout. The bus server name is `promptobus`.
