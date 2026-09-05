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

**The command surface does not exist yet.** There is no `models` command, no `--strategy` and no `--allow-payg`, and `--help` names none of them; PB-21 adds them. What is below them does exist and is marked where it does — [Availability](#availability-the-adapter-the-preflight-and-the-cache), [Catalog and overlays](#catalog-and-overlays) and the [Resolver](#resolver) run today, as libraries with no command in front of them. This section is the contract [ADR-003](../adr/adr-003-model-routing.md) fixed and PB-13…PB-21 implement against, written here first so that the shapes, the flags and the codes are decided once instead of nine times, and so the golden fixtures in `test/fixtures/model-routing/` have something to be golden against.

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
| `stale_cache` | `unknown` | The cache entry is absent or outlived its TTL and no probe ran — `--dry-run` without `--refresh`, or the preflight budget was spent. The two cases are told apart by the stamp, not by a second code: an entry that expired keeps its own `checkedAt`, one the cache never held carries the epoch — never checked. `source` stays `cache` for both, because the cache is what was consulted and the enum has no fourth value |
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
| catalog | `models/catalog.json`, shipped with the package | `schemas/model-routing/catalog.schema.json` |
| overlays | `host.routingPaths().overlays`, lowest precedence first | standalone: `user`, then `workspace` ([02-host](02-host.md)) |
| availability cache | `host.routingPaths().cacheFile` | mode `0600`; no prompt, token, email or open account id |

### Availability: the adapter, the preflight and the cache

Implemented, and the only routing part that is: PB-14 shipped the harness-neutral half — the adapter contract, the budgeted preflight and the cache — while the three real adapters (PB-15…PB-17), the resolver (PB-18) and the flags (PB-21) are still ahead. Until an adapter exists for a harness, that harness answers `unknown` / `probe_failed`, which the resolver penalises rather than blocks.

**The adapter** is one method a driver declares as `availability` (`src/model-routing.ts`, `src/driver.ts`):

```ts
probe({ host, timeoutMs, refresh }): ProbeVerdict | Promise<ProbeVerdict>
```

`timeoutMs` is the whole preflight budget — adapters run in parallel, so each may use all of it. The verdict is one harness entry of the availability snapshot, so nothing translates between a probe and the file:

| Field | Meaning |
|---|---|
| `state` | `available`, `exhausted`, `unavailable` or `unknown` |
| `reason` | one of the nine codes above, `null` exactly when the state is `available` and nothing qualifies it |
| `message` | a human diagnosis. **Never harness output verbatim**: this is the one free-text field that reaches disk |
| `checkedAt` | ISO-8601 with milliseconds; the preflight stamps one if the adapter omits it |
| `source` | `probe` — this run asked the harness; `cache` — a live entry was reused; `manual` — a person marked it. Nothing in v1 writes `manual`: it is reserved for a person marking a harness by hand, and no command does that yet |
| `resetAt` | when an exhausted limit is known to reset; `null` means unknown |
| `version` | the harness binary version, when the probe read it |
| `models` | the inventory the account exposes. An adapter does not fill `rated` — it knows the harness, not the catalog |
| `windows` | normalised limit windows. A harness that exposes none reports none; the remaining limit is then unknown, never modelled |

An adapter that **throws** is `unknown` / `probe_failed`, and the thrown text is discarded rather than written: an adapter wrapping harness output in an error would otherwise put it on disk. An adapter with something to say answers with a verdict.

An adapter that **answers outside the contract** is `probe_failed` too, and the diagnosis names the field. All three closed lists are checked — the state, the reason and the source — plus a `checkedAt` that cannot be read; a reason is required for every state but `available`, which is the only one none of the nine codes accompanies. The written cache promises to validate against its schema, and a misspelt `quota-unknown` would break that promise from inside: the command would report success and leave a document nothing can read back. The offending value is quoted back only when it has the shape of a code, so the message can show a typo without becoming a second route for harness output.

Inside `models` and `windows` the check is by value and it **drops the element, not the verdict**: a blank model name, a `usedPercent` outside 0…100, a `lengthSec` of zero, a repeated flag. An adapter that garbles one row of an inventory still knows whether the account is logged in, and nothing here repairs a value — a number invented by the mechanism would validate while saying what no harness said. A `resetAt` that cannot be read becomes `null`, the schema's own word for unknown.

**The preflight** (`lib/model-routing/preflight.js`) runs every adapter at once under one total budget of 15 s (`PREFLIGHT_BUDGET_MS`). A harness that has not answered by then is `unknown` / `probe_timeout` and does not hold the command: the person waits once for the slowest harness, never three times in a row. The result is the availability snapshot, valid against `schemas/model-routing/snapshot.schema.json`.

What is asked, and what is taken from the cache:

| Run | Probed | Taken from the cache |
|---|---|---|
| plain | harnesses with no live entry | every live entry |
| `--refresh` | everything except a reset-less exhaustion | a reset-less exhaustion, which no probe can lift |
| `--dry-run` | nothing | every live entry; the rest is `unknown` / `stale_cache` |
| `--refresh --dry-run` | as `--refresh` | as `--refresh` — and nothing is written |

**The cache** (`lib/model-routing/cache.js`) sits at `host.routingPaths().cacheFile`, mode `0600`, written as a temporary neighbour and renamed over, with its directory created as needed. Entries are merged, never replaced wholesale: a late-start mark writes one harness without re-probing the others.

TTLs, as a cascade — the first line that matches an entry wins:

| Entry | Live until |
|---|---|
| `exhausted` with a `resetAt` | that reset |
| `exhausted` with no `resetAt` | `--clear-exhausted`, and nothing else. `--refresh` does not lift it, and such a harness is not even probed |
| `probe_timeout` or `probe_failed` | `checkedAt` + 5 min |
| carries `windows` | `checkedAt` + 60 s — an entry is only as fresh as the fastest fact inside it |
| anything else | `checkedAt` + 1 h — auth and model inventory |

The file holds **no prompt, no token, no email and no open account id**. The mechanism is not a filter but the shape: a verdict is projected field by field onto the closed snapshot schema before it is written, so anything an adapter attached beside the declared fields never travels. v1 assumes one locally authenticated account per harness, so the file carries no account key at all; the schema keeps a `fingerprint` slot for the day that changes, and the rule that comes with it is that the key must be opaque and one-way.

Two library entry points have no flag of their own yet. `clearExhausted(host, harness)` is the `--clear-exhausted` half: it drops a reset-less exhaustion and reports whether there was one, and it leaves an exhaustion that names its reset alone. `markExhausted(host, harness, { resetAt })` is the late-start hook — a driver whose session failed to start on a limit calls it, and the harness is `subscription_exhausted` with that reset, or `manual_exhaustion` without one. Its `source` is `probe`, not `manual`, and the two words are about different things: the harness itself said so — it was asked to start and answered — while `manual` means a person typed it, which nothing in v1 does. The reason code is what carries "only a person clears this"; the source carries who learned it. The mark is per harness, not per tuple: the snapshot has no tuple dimension, and a limit is an account fact. A `dryRun` option makes every one of these writes a no-op.

### Catalog and overlays

The catalog file, the layer merge and the checks behind `models validate` exist today; the command that prints them is PB-21. The operational half — what is in a row, how the layers combine, the canonical-priority convention, and the overlay file a person copies — is [guides/model-routing.md](../guides/model-routing.md).

Three library entry points, all in `lib/model-routing/`:

| Call | What it answers |
|---|---|
| `loadCatalog({ host, constraints })` | the merged tuple list and policy: the shipped catalog, then every overlay `host.routingPaths().overlays` names in that order, then the caller's constraints. A missing overlay file is normal; a present but unreadable one is a `GateError` |
| `validate({ host, constraints })` | `{ ok, errors, warnings, layers }` for the real stack. A broken file is a finding here, not a throw — this is the call a person makes when a file is broken |
| `validateLayers({ canonical, overlays, constraints, now })` | the same verdict for documents already in memory: `canonical` is `{ data }`, each overlay `{ id, path, present, data }`. Pure, so a consumer can check a policy layer it ships without touching disk |

`--harness`, `--model` and `--effort` reach the merge as constraints and are carried through untouched — the resolver applies them. `--allow-payg` is the one constraint that changes policy at that layer, and it is opt-in: its absence does not undo an overlay that opted pay-as-you-go in.

`validate` covers the shape of every layer, duplicate tuple ids, a harness no driver of this CLI drives, an effort outside that driver's `EFFORT_LEVELS`, weights that do not sum to 100, references to a tuple, model, harness or effort that does not exist, and a name that is both allowed and denied. Its warnings are `stale-rating` — a rating older than `STALE_RATING_DAYS` (90), never an exclusion — and two of its own, `priority-duplicate` and `priority-not-canonical`, which check the canonical-priority convention the guide documents and never reach a decision.

A finding carries `code`, the `layer` id it belongs to, `at` for the field, and `message`. `layer` is whoever last wrote the key in question — the overlay that wrote that weight set or that deny list, and `defaults` where none did. A warning carries `code` and `message` first and its facts after: those two fields are the whole of a warning in the decision document (`warnings` in `decision.schema.json` is closed on them), **so a decision copies `code` and `message` and translates nothing**.

### Cursor

Implemented (PB-16). The adapter is `lib/model-routing/adapter-cursor.js`, declared by `lib/driver-cursor.js` as its `availability`. It runs two commands and nothing else — `status` for auth, `models` for the inventory — on the binary `host.resolveToolBin('cursor')` names, the same one the driver lifts a session with. It starts no session, writes nothing, and never touches the persist/tmux path: an adapter answers about the account, before any session exists.

| What the probe sees | Verdict |
|---|---|
| the host resolves no binary, or the one it named is gone | `unavailable` / `binary_missing` |
| the binary is there and will not run — no permission, an argument the platform cannot carry | `unknown` / `probe_failed` |
| either command outlives what is left of the budget | `unknown` / `probe_timeout` |
| `status` says the account is not logged in | `unavailable` / `not_authenticated` |
| `status` says neither thing, whatever its exit code | `unknown` / `probe_failed` |
| logged in, but the listing refused or came back unreadable | `unknown` / `probe_failed` |
| logged in, inventory in hand | `unknown` / `quota_unknown`, with `models` and `version` |

**A successful probe is `unknown`, not `available`.** Cursor exposes no limit API, no usage subcommand and no window the binary will name, so the remaining limit cannot be established at all; `available` would claim it was confirmed. No `windows` are reported either — an empty list would age the entry at the 60 s window TTL for a fact nothing measured, and a number invented here would read as a measurement. `unknown` is penalised by the resolver rather than blocking, so the harness stays a candidate.

**A slow binary is a timeout, never an unavailable account.** `timeoutMs` is the whole preflight budget and both calls share it: what is left of the budget is the ceiling of the next call, and a binary still running when it ends is killed. The deadline starts before the binary is resolved, because resolving is part of the probe — a host is free to run `--version` inside `resolveToolBin`, and a deadline started after it would let one adapter spend that ceiling plus the whole budget. A launch that fails outright is `probe_failed` rather than a timeout: a binary that never started did not fail to answer in time. Calling a slow `cursor-agent` `unavailable` would drop every Cursor tuple out of a run on a machine where the account is perfectly fine.

**What the parse relies on**, measured on `cursor-agent` 2026.09.02-c22c1a3 (2026-09-05). Both commands colour their output even when stdout is not a terminal, so ANSI is stripped before anything is looked at. `status` answers `✓ Logged in as <account>` and exits 0 in both the signed-in and the signed-out case, so **the text is the answer and the exit code is never consulted** — a non-zero code beside a line the adapter can read says nothing about the login. The signed-out line is matched separately, because "not logged in" contains "logged in". Output that says neither thing is a third answer rather than a second: it is `probe_failed`, because calling it a logged-out account would send the person to `cursor-agent login` for a parse fault and cost them the real diagnosis. `models` answers a header line, `<id> - <Display Name>` rows — about 210 of them, `auto` first — and a trailing `Tip:` line, so a row is recognised by the shape of its id next to a literal ` - `, not by being a line with two fields in it. **The model id is taken whole, effort suffix included**: in Cursor the effort level is a flat suffix of the id (`claude-opus-5-thinking-max`, `cursor-grok-4.6-xhigh-fast`) and not a separate flag, so a stripped suffix would name a model the binary does not have.

A `(NO ZDR)` mark on a row travels as `flags: ['no-zdr']` on that model and **is not judged here**. The package carries what the harness said; a consumer that must not use a model outside zero-data-retention denies it in an overlay, and it can only do that if the mark arrived.

A listing that refused, or one nothing in it parses, is `probe_failed` rather than an inventory of none. Every account with a subscription lists about 210 models, so an empty result is a parse fault, and reporting it as an empty inventory would exclude every Cursor tuple as `model-not-in-inventory` and send the person to the catalog for a fault that is not there.

`version` is whatever the host read while resolving the binary; nothing is asked for it, because resolve already runs `--version` and the driver reads the same field at option refuse. A host that reports none leaves the field out.

Nothing the binary printed reaches `message`. `status` prints the account address on the one line the adapter reads, and the adapter counts and classifies instead of quoting.

**Late-start classification is not implemented for Cursor, and the gap is deliberate.** The other harnesses hand `markExhausted` a limit their start path named; Cursor's start path names nothing. The only text `spawn` gets back from a failed lift is a string the package itself composes, and the driver says so in its own words next to the `failed` stall route — *a wrong model id and an expired Cursor login look the same*. Hooking a mark to it would fire a sticky `manual_exhaustion` — which only `--clear-exhausted` lifts — on a typo in `--model`. So a Cursor limit hit at start is not marked in the cache today, and the follow-up finding on PB-16 carries the two candidate routes to a real signal.

### Resolver

A library, like the two subsections above it: `promptobus models`, `--strategy` and `--allow-payg` are PB-21's. Two entry points, both in `lib/model-routing/`:

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

The pair `test/fixtures/model-routing/decision.json` and `models.txt` is reproduced from `catalog.json` and `snapshot.json` by `test/model-routing-resolver.test.mjs` — the JSON after the normalisation [its README](../../test/fixtures/model-routing/README.md) states, the text byte for byte.

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
