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
promptobus models [--strategy <quality|balanced|speed|economy>] [--role <worker|reviewer>] [--refresh] [--json]
promptobus models validate
promptobus models --clear-exhausted <harness>
promptobus spawn  … [--strategy <quality|balanced|speed|economy>] [--allow-payg] [--refresh]
promptobus review … [--strategy <quality|balanced|speed|economy>] [--allow-payg] [--refresh]
```

`models` prints what the resolver would pick right now: the chosen tuple, every candidate it considered with its score components, the models the account exposes that the catalog does not rate, and the warnings. `--strategy` defaults to `balanced` and `--role` to `worker`. The text form prints at most eight unrated rows per harness and counts the rest (`… and N more`); `--json` carries every row, so the two outputs cannot drift.

**`models` has no `--dry-run`, because it is one.** It reads the availability cache and asks no harness anything; `--refresh` is the only flag that makes it probe, and therefore the only one that writes a cache entry. The reason is the ADR's: this is the command a person types to ask a question, and a question that starts three harness binaries and waits out the preflight budget is not one. `--dry-run` belongs to `spawn` and `review`, where the alternative to a dry run is a lift.

**`models` prints the availability it decided on, and both forms print the same one.** Under the candidates comes an `availability:` block: one line per harness with its state and its tier, and under it one line per window — the window's id, its `kind`, the percentage used, its `lengthSec`, what it binds, and its reset time. The block travels **inside the decision document** (`harnesses`, [ADR-004](../adr/adr-004-subscription-balance.md)), assembled by the command from the snapshot after the resolver has answered, because the resolver reads no disk. That is why it is in the document rather than only on the page: `render` prints the decision and nothing else, so a text form fed from a second source would show what `--json` does not carry. The block is optional — a decision assembled without a snapshot in reach is still a decision, and prints no such section.

A `kind` is a **name** and `lengthSec` is the **number**, and the line prints both without deriving one from the other: a `monthly` billing cycle is not thirty days, and a label invented from a length would be a second, quieter claim about the same fact. A window binds `account`, one `model` family by the name the harness gave it, or one `pool`; the ids behind a scope are in `--json` for a machine and not on the page for a person.

**The age is the facts', not the run's.** `snapshot.takenAt` in a decision is the OLDEST entry's own `checkedAt`, and `ageSec` measures from it: a snapshot is only as fresh as the stalest thing inside it, which is the rule the cache TTL cascade already applies to a single entry. The moment the command ran is not it — a cache-only run would print `0 s old` over an entry from yesterday, and a mixed run, where one harness answered a second ago and two are hours old, would report the freshest of the three. A cache the run never held carries the epoch as its stamp, so a first run says its facts are ageless rather than freshly measured; `stale_cache` on every harness row says the same thing again. The text output prints that case as `snapshot: never checked · source cache` and no age — an age counted from the epoch is true and useless — while `--json` keeps the literal `takenAt` and `ageSec`, because a machine reader wants the number and a person does not.

`--json` prints the decision document; its shape is `schemas/model-routing/decision.schema.json` and it is pinned by `test/fixtures/model-routing/decision.json`. The text output is pinned byte for byte by `models.txt` next to it: candidates are printed in the order the decision document lists them — scored first by descending total, then excluded ones by canonical priority.

`models validate` checks the catalog and every overlay: schema, references to tuple, model and harness, rating ranges, weight sums, duplicate ids, and rules that both allow and deny the same name.

`models --clear-exhausted <harness>` drops an exhaustion the cache is holding with no known reset. Nothing else clears one: an exhaustion with a reset expires by itself.

`--strategy` on `spawn` and `review` hands the resolver an intent. `auto` is not a value here — the orchestrating agent turns a task into one concrete strategy before the call. Without `--strategy` the command takes today's path exactly, with today's defaults.

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
| `quota_unknown` | `unknown` | Auth is fine; this harness exposes no stable source for the remaining limit |
| `stale_cache` | `unknown` | The cache entry is absent or outlived its TTL and no probe ran — `--dry-run` without `--refresh`, or the preflight budget was spent. The two cases are told apart by the stamp, not by a second code: an entry that expired keeps its own `checkedAt`, one the cache never held carries the epoch — never checked. `source` stays `cache` for both, because the cache is what was consulted and the enum has no fourth value |
| `manual_exhaustion` | `exhausted` | A limit the machine observed and no reset time is known for. `markExhausted` writes it when a lift was refused on a spent limit and the harness named no reset; nothing else writes it, and **no person marks a harness in v1**. The code says who may clear it — only `--clear-exhausted` — not who wrote it |

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

They are `PromptobusError` codes and live in `ERROR_CODES` (`src/v1/errors.ts`) — which is why they are `kebab-case` while the snapshot's reason codes above keep the `snake_case` the decision fixed. The drift check reads this table against that list, so the two cannot part.

`limit-hit-at-start` is raised by the lift itself (`lib/liftoff.js`): the two refusal branches that hold the harness's own words — a non-zero exit and a session that never came up — throw a `PromptobusError` with that code **when the late-start hook marked the cache**, and end through `fail()` when it did not. So the code means both halves at once: the limit was hit AND the harness is now marked exhausted. A limit refusal whose mark could not be written — an unreadable routing path, a read-only directory — leaves through `fail()` with no code, because there is no mark for a consumer to act on and the person still gets the same diagnosis. What a person reads does not change either way: the CLI catch prints a `PromptobusError` as one line and exits 1, exactly as `fail()` does.

| Code | When |
|---|---|
| `strategy-unknown` | `--strategy` is not one of the four values |
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
| overlays | `host.routingPaths().overlays`, lowest precedence first | standalone: `user`, then `workspace` ([02-host](02-host.md)) |
| availability cache | `host.routingPaths().cacheFile` | mode `0600`; no prompt, token, email or open account id |

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
| `credits`, `resetCredits` | informational, and Codex is the only harness with them: whether the account holds spendable credits at all, and how many window resets it may spend. Nothing scores them and nothing spends one — the **amount** is deliberately not carried, being a fact about the account rather than about the plan |
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

**A ban is final from below.** A layer replaces an allow or deny list whole, per selector kind, and it cannot clear one: the overlay schema refuses `deny: {}` and `deny: { models: [] }` alike, and every denied name must exist in the merged catalog, so "deny nothing" cannot be written. A higher layer swaps a ban for a different ban or leaves it standing; nothing above lifts it. Read ADR-003's layer ordering with that in mind — the workspace layer sits above a consumer policy layer and can restate any rule, but a consumer's ban survives a workspace file that does not name that selector kind. Lifting one means changing the layer that wrote it.

`validate` covers the shape of every layer, duplicate tuple ids, a harness no driver of this CLI drives, an effort outside that driver's `EFFORT_LEVELS`, weights that do not sum to 100, references to a tuple, model, harness or effort that does not exist, and a name that is both allowed and denied. Its warnings are `stale-rating` — a rating older than `STALE_RATING_DAYS` (90), never an exclusion — and two of its own, `priority-duplicate` and `priority-not-canonical`, which check the canonical-priority convention the guide documents and never reach a decision.

A finding carries `code`, the `layer` id it belongs to, `at` for the field, and `message`. `layer` is whoever last wrote the key in question — the overlay that wrote that weight set or that deny list, and `defaults` where none did. A warning carries `code` and `message` first and its facts after: those two fields are the whole of a warning in the decision document (`warnings` in `decision.schema.json` is closed on them), **so a decision copies `code` and `message` and translates nothing**.

### Claude Code: what its adapter asks

Implemented (PB-15). The adapter is declared as `availability` on the Claude Code driver and lives in `lib/model-routing/adapter-claude.js`. One probe is **two reads and no turn**: the binary from the host, then one auth check.

| Fact | Where it comes from |
|---|---|
| binary, version | the preflight's resolve of `claude`, handed over as `toolBin` — the adapter neither searches `PATH` nor resolves anything itself |
| auth | `claude auth status --json` |
| models | the driver's own dictionary: the pinned ids the catalog rates, its alias set, and its `DEFAULT_MODEL` (`lib/driver-claude.js`) |
| remaining limit | nowhere. There is none |

**Nothing runs `claude` with a bare word.** An unrecognised word after the binary name is not an unknown subcommand — it is taken as a PROMPT and starts a turn on the person's plan. So the argv is a subcommand `claude --help` lists with flags that subcommand's own `--help` lists, and the suite pins it whole.

**The inventory is not a listing.** On `claude` 2.1.251 the binary publishes no model list at all: no `models` subcommand and no `--list-models` (`claude --list-models` → `error: unknown option`, exit 1). So the inventory is the driver's dictionary — `MODEL_IDS`, `MODEL_ALIASES` and `DEFAULT_MODEL` — handed to the adapter by the driver rather than imported back out of it, because a module of the mechanism reaching into a driver is the crossing the adapter-boundary gate refuses. **This adapter imports no driver module at all** — the dependency runs one way, `driver-claude.js` → `adapter-claude.js` — so it passes that gate on its own and is deliberately absent from the gate's `DRIVER_OWN` exemption list: an exemption a file does not need would hide the crossing the list exists to catch. It is in `DRIVER_PRIVATE` instead, which is the other half of the same rule — the driver may import it, and nothing else in `lib/**` may. A name in that list the catalog does not rate is not a mistake: it becomes an unrated runtime row, which is what the three aliases are.

**The rated names are full ids, and the aliases are not.** `--model` takes either — its help says "an alias for the latest model … or a model's full name (e.g. 'claude-fable-5')" — but an alias names whatever the vendor points it at today, so a catalog row keyed on one keeps its ratings and its `assessedAt` through a re-point and starts describing a model nobody assessed, with nothing going red. The rated rows therefore name `claude-opus-5` and `claude-sonnet-5` (`MODEL_IDS`), the suite pins every Claude row against that set, and the hazard is written for a person in [guides/model-routing.md](../guides/model-routing.md). The lift is untouched: an alias is as lawful at `--model` as it ever was, and `DEFAULT_MODEL` is still one.

**`claude auth status --json`** is the whole auth check, and it is the one non-interactive check the binary offers today (measured 2026-09-05 on 2.1.251: three runs at 0.86 / 1.17 / 1.36 s, exit 0, one JSON object). Its keys are `loggedIn`, `authMethod`, `apiProvider`, `analyticsDisabled`, `projectsDirectory`, `email`, `orgId`, `orgName`, `subscriptionType`. **Exactly one of them is read** — the `loggedIn` boolean. Three of the rest are an email address and an open account id, which the cache promises never to hold, so they stop at the adapter and the suite greps the written snapshot for them.

The verdict, by what was found:

| Found | Verdict |
|---|---|
| no binary | `unavailable` / `binary_missing` |
| `loggedIn: false` | `unavailable` / `not_authenticated` |
| `loggedIn: true` | `unknown` / `quota_unknown`, with `version` and `models` |
| an answer the adapter cannot read — an older build with no `auth` subcommand, a moved shape, empty output | `unknown` / `quota_unknown`, and the message says auth could not be verified |
| the check was killed by the adapter's own deadline, or `ETIMEDOUT` | `unknown` / `probe_timeout` |
| the check was killed by a signal the adapter did not send | `unknown` / `probe_failed`, naming the signal |
| the check would not run at all | `unknown` / `probe_failed` |

**`available` is a state this harness cannot reach in v1, and that is deliberate.** The word means auth, model *and* limit confirmed; Claude Code exposes no stable, documented source for the remaining subscription limit, and an adapter that cannot obtain one answers `unknown` rather than modelling a value. So a healthy logged-in account is `unknown` / `quota_unknown` with no `windows` at all, which the resolver penalises with `unknown-availability` (−10, the limit counted as a neutral 50 %) and reports as the `unknown-remaining` warning — never a block. An unreadable answer is not `not_authenticated`: a guessed logout would take every tuple of the harness out of routing on no evidence.

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

**What it never asks.** `getAuthStatus` would be a crisper auth signal and answers `{ authMethod, authToken, requiresOpenaiAuth }` — it hands back a **token**, and `message` is the one free-text field of this module that reaches disk. `account/read` answers the account **e-mail**. Neither is called, and neither should be added: the verdict is built from limit numbers and model names, which are the only two things a snapshot may carry.

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

**Windows** are `primary` and `secondary`, under the names the payload gives them: `usedPercent` as it stands, `lengthSec` from `windowDurationMins` × 60, and `resetAt` from `resetsAt` — unix **seconds** on the request, an ISO string on the notification, and `null` when it is neither. Nothing is renamed into hours and days: the length is a number the harness states, and a label invented from it would be a second, quieter claim about the same fact. A snapshot that names no window but carries the numbers at its own top level is ONE window and it is `primary` — that is not an invention either: `rateLimitReached` counts the snapshot itself among the windows it checks and `rateLimitNote` reads `snap.usedPercent`, so the flat form has always been the primary window written without its name, and reading it as "no window" would publish a spent limit as an exhaustion with no reset — the sticky kind — over a limit the harness had timed. A `resetsAt` outside the range a timestamp can have (milliseconds handed over where seconds were meant) is `null` rather than a value divided by a thousand: the repaired one would validate and be a time nothing said. `planType`, `credits` and `individualLimit` are read by nothing and reach no verdict.

**Models** come from `model/list`, which answers after `initialize` alone. The ones app-server marks `hidden` are **left out**: it hides what it does not offer, and an inventory carrying them would hand the resolver candidates the harness itself declines to show. No `flags` are attached — Codex prints no mark on a listed model that means anything to a policy. A `model/list` that refuses costs the inventory and nothing else; the limit verdict still stands. An adapter publishes what the account exposes, and matching that against a named model is the resolver's question and the lift's refusal, not the preflight's — which is why the snapshot vocabulary has no code for it at all.

**The budget** is the preflight's whole `timeoutMs`, spent as a deadline rather than divided: each request is capped by the smaller of its own ceiling (`INIT_TIMEOUT_MS`, `LIMIT_READ_TIMEOUT_MS`, `MODEL_LIST_TIMEOUT_MS`) and what is left of it, and the notification fallback by the smaller of `limitWaitMs()` and the same remainder. An app-server that dies is not waited for at all — it answers `probe_failed` at once instead of holding a budget three harnesses are sharing.

### Cursor

Implemented (PB-16). The adapter is `lib/model-routing/adapter-cursor.js`, declared by `lib/driver-cursor.js` as its `availability`. It runs two commands and nothing else — `status` for auth, `models` for the inventory — on the binary the preflight resolved for it, the same one the driver lifts a session with. It starts no session, writes nothing, and never touches the persist/tmux path: an adapter answers about the account, before any session exists.

| What the probe sees | Verdict |
|---|---|
| the preflight resolved nothing — the host has no `resolveToolBin`, or its call threw | `unknown` / `probe_failed` |
| the host says there is no such binary, or the one it named is gone | `unavailable` / `binary_missing` |
| the binary is there and will not run — no permission, an argument the platform cannot carry | `unknown` / `probe_failed` |
| either command outlives what is left of the budget | `unknown` / `probe_timeout` |
| `status` says the account is not logged in | `unavailable` / `not_authenticated` |
| `status` says neither thing, whatever its exit code | `unknown` / `probe_failed` |
| logged in, but the listing refused or came back unreadable | `unknown` / `probe_failed` |
| logged in, inventory in hand | `unknown` / `quota_unknown`, with `models` and `version` |

**A successful probe is `unknown`, not `available`.** Cursor exposes no limit API, no usage subcommand and no window the binary will name, so the remaining limit cannot be established at all; `available` would claim it was confirmed. No `windows` are reported either — an empty list would age the entry at the 60 s window TTL for a fact nothing measured, and a number invented here would read as a measurement. `unknown` is penalised by the resolver rather than blocking, so the harness stays a candidate.

**A slow binary is a timeout, never an unavailable account.** `timeoutMs` is what is left of the preflight budget and both calls share it: what remains is the ceiling of the next call, and a binary still running when it ends is killed. The binary was resolved before the probe started, so the ceiling a host spends inside `resolveToolBin` is already out of this adapter's way. A launch that fails outright is `probe_failed` rather than a timeout: a binary that never started did not fail to answer in time. Calling a slow `cursor-agent` `unavailable` would drop every Cursor tuple out of a run on a machine where the account is perfectly fine.

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
2. the allow and deny lists of the merged policy, then `--harness`, `--model` and `--effort` — `denied-by-policy`, whose `detail` names the layer that wrote the list, then `constraint-mismatch`. Allow lists of different selector kinds hold at once: a tuple must be named by every allow list there is, and the first one that does not name it is the one reported;
3. tuples not rated for the role — `role-not-allowed`;
4. tuples whose model the account does not expose — `model-not-in-inventory`. A harness that reported no inventory at all excludes nothing: silence is not absence;
5. `unavailable` and `exhausted` harnesses — `harness-unavailable`, `harness-exhausted`;
6. pay-as-you-go without `--allow-payg` — `payg-not-allowed`;
7. scoring;
8. the reviewer rules;
9. the tie-break.

**A harness the snapshot does not carry is filtered out, not excluded.** The preflight is asked about the harnesses the workspace declared, so the snapshot's harness set is that declaration, and ADR-003 says the catalog is filtered by it. On a workspace that declares only `claude`, the Cursor and Codex tuples are absent from `candidates` rather than listed with a reason — they were never considered, and the exclusion list has no code that would be true of them. The cost is that `resolve` alone cannot tell "you named a harness this workspace never declared" from "nothing survived filtering": both end with `chosen: null`. Telling them apart is the command's job and it happens before the call — an explicit `--harness`, `--model` or `--effort` that matches no tuple of the merged catalog is `constraint-unknown`, and a `--clear-exhausted` naming an undeclared harness is `harness-unknown`, both from the table above.

**Scoring** is the weight table of the merged policy over four values. `quality` and `speed` are 1–5 ratings normalised as `(r − 1) / 4 × 100`; `quotaCost` is inverted, `(5 − r) / 4 × 100`, so a smaller spend contributes more; `remaining` is not a rating but `100 − max(usedPercent)` over the harness's windows. A tuple's `roleRatings` override its ratings for the role being routed. A component is its weight over 100 times that value, and all four are published, so a reader can divide one back by its weight and recover the input.

A harness that is `unknown`, or that exposes no window at all, has no remaining limit to read: it counts as a neutral 50 % and the candidate loses the `unknown-availability` points. Penalised, never blocked — that is the fourth row of the ADR's decision table.

**The extra rules** are the ADR's, and every number in them comes from the merged policy, so an overlay moves it: `live-participant` costs points for each participant already up on that harness and is capped; `reviewer-diversity` adds points to a reviewer whose harness or model differs from every live worker's — with no live worker there is nothing to differ from and no bonus; and the reviewer quality floor is a **choice rule, not a filter**. A candidate below the floor keeps its place in the list with its score, and only the pick moves past it; when nothing reaches the floor the best remaining candidate is taken with a `reviewer-floor-not-met` warning rather than the run refusing.

**The tie-break** is effective score, then confirmed availability, then canonical priority, then the tuple id. It is total, because two tuples cannot share an id — which is why a duplicate id is an error in `models validate` and not a warning.

The decision reports what the caller pinned in `constraints`, and `applied` there is literal: it is true when a named value actually narrowed the list, so `--harness claude` against a claude-only catalog reports `false`. Warnings taken from the merge are copied with their `code` and `message` and nothing else; `unknown-remaining`, `snapshot-stale` and `probe-incomplete` are the resolver's own and are raised once per harness whose candidates were scored.

The pair `test/fixtures/model-routing/decision.json` and `models.txt` is reproduced from `catalog.json` and `snapshot.json` twice, and the two runs are not a duplicate of each other: `test/model-routing-resolver.test.mjs` calls the pure function with synthetic paths, and `test/model-routing.test.mjs` runs the `models` command itself against a real host and substitutes the paths that run actually has. Both compare the JSON after the normalisation [its README](../../test/fixtures/model-routing/README.md) states, and the text byte for byte.

## Status, done, dismiss, history, prune

`status` lists active tasks, participants, unread counts, and warden health. A participant lifted with `--strategy` also gets its routing line — the strategy, the tuple, the score, how old the availability snapshot was when the pick was made, and the warnings — read out of `metadata.routing` ([04-protocol](04-protocol.md)) through the accessor. The strategy envelope agreed before a run is therefore auditable during it, not only at its start.

A Cursor participant's liveness is judged by **three** signals, and a stall verdict needs all three quiet: the chat transcript growing, an instrumental process under the session's tmux pane, and a write in the participant's own worktree — the newest mtime among `git ls-files -mo --exclude-standard` plus its HEAD commit time (`lib/cursor-persist.js`). The third exists because the agent edits files inside one long call and spawns nothing, so the first two see a session that is working as one that is silent. It is **positive only**: a recent write lifts the verdict, its absence never raises one, and a session nothing writes for still stalls once the threshold passes. The verdict names each measurement and its span, so a silent transcript can be told from a dead session without opening the panel.

`done` closes the task. The mailbox owner may call it. Sessions the bus started are stopped unless `--keep-sessions`. Journals of tasks closed more than `PRUNE_DEFAULT_DAYS` (14) days ago are removed on that last call.

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
