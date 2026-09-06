# ADR-003: Model routing: strategies, catalog, availability snapshot, resolver

**Status:** Accepted
**Date:** 2026-09-05
**Deciders:** Pavel Kim (project owner)
**Partly superseded by:** [ADR-004](adr-004-subscription-balance.md) (2026-09-06), in five sections and no others — § Strategies (the four values of `--strategy`, and "a call with no `--strategy` routes nothing" where an overlay sets a default), § CLI surface (the same list of values), § Overlays (the "Clarification, 2026-09-05" merge rule, and the standalone path of the `workspace` layer in the table there), § Resolver (the reviewer quality floor of 4), and § Host contract ("`promptobusHome()` is not used for routing"). Everything else here stands as written. The four decision rows below stand as decisions — row 2 included: it decided that the reviewer floor is a POLICY VALUE rather than a constant, which is exactly what lets ADR-004 move its default from 4 to 5 and add a worker floor beside it, without reversing anything decided there. ADR-004 § "What this supersedes in ADR-003" is the whole list and names what only looks superseded.
**Partly superseded by:** [ADR-005](adr-005-ten-point-scale-absolute-bands-calibrate.md) for the 1–5 catalog scale and `/ 4` rating normalisation; ADR-005's supersession table is exhaustive.

## Context

`spawn` and `review` take `--harness`, `--model` and `--effort` and pass them to a driver. Nothing in the package knows whether the named model is good for the job, whether the local account can run it right now, or what a run costs against a subscription. The person picks, and picks blind: the effort dictionaries live in the drivers (`lib/driver-claude.js` line 81, `lib/driver-cursor.js` line 146, `lib/driver-codex.js` line 41), each driver names a `defaultModel`, and none of that is comparable across harnesses.

The gap shows twice. A worker on a cheap model where the task needed the expensive one is paid for in review rounds. A worker on a harness whose subscription is exhausted is paid for at liftoff: the Codex driver already refuses there (`lib/codex-session.js` line 826, `rateLimitReached`), but only after a task, a worktree and a participant record exist.

The first consumer's owner wrote a routing plan on 2026-09-04 that closes both: pick the model for a worker or reviewer by one of four strategies, from a catalog of rated `role + harness + model + effort` tuples, intersected with what the local account can actually run, with a deterministic scoring resolver. The bus has since moved into this package, so everything harness-neutral in that plan belongs here; a consumer keeps only its own policy and its own skills.

One correction to the task text this ADR was cut from, made before anything was written: it said the cache and the global overlay live under `promptobusHome()`. They do not. `promptobusHome()` is the task store of one workspace (`src/standalone.ts` builds it as `homeOfRoot(workspaceRoot())`), while auth, model inventory and the remaining limit belong to the account, which is the same account from every checkout on the machine. The owner's actual decision — the standalone host answers `~/.promptobus/…`, a consumer maps to its own home — is what this ADR records; the approver authorised the reversal on 2026-09-05. It is not a row of the decision table below: nobody decided it the other way, the task text simply named the wrong method.

This is the contract before the code, the order the extract itself followed: the host contract first, consumers repin after. Nine tasks build on it — the catalog (PB-13), the preflight and cache (PB-14), three adapters (PB-15…PB-17), the resolver (PB-18), the skill rubric (PB-19), the flags and the `models` command (PB-21), the docs and the release (PB-20). Each of them needs the shapes and the numbers fixed here, not re-derived. The series releases once, at its closing task: nothing between here and there moves the package version, and consumers repin to that one release rather than to a step of it.

## Options

**Decision 1 — where the choice is made.**

- **1A. The agent picks a concrete model and passes `--model`.** No package change at all. The agent cannot see auth, inventory or the remaining limit of the local account, so it guesses at exactly the two facts that decide whether the run starts.
- **1B. The CLI picks, the agent names an intent.** The agent classifies the task into a strategy; the CLI intersects a rating with live availability and picks a tuple. The package grows a catalog, adapters and a resolver, and owes an explanation for every pick.

**Decision 2 — the unit of choice.**

- **2A. The model.** Effort is then a second, independent axis, and the pair `model + effort` is scored twice.
- **2B. The tuple `role + harness + model + effort`.** One rated row per thing that can actually be launched. Cursor forces this hand anyway: it carries effort as a suffix of the model id (`lib/driver-cursor.js` around line 140), so `model` and `effort` are not separable there.

**Decision 3 — where the ratings live.**

- **3A. In code.** A rating change is a release.
- **3B. A shipped JSON catalog plus person-editable overlays.** A rating change is a data change; a person can deny a model in one workspace without forking anything.

**Decision 4 — what an unknown remaining limit does.**

- **4A. Block.** No account exposes a stable quota API for all three harnesses, so this blocks almost everything almost always.
- **4B. Penalise.** The run starts on best effort, the uncertainty is visible in the output, and a candidate with a confirmed remaining limit outranks one without.

## Decision

**1B, 2B, 3B, 4B.** The concrete rules follow. Every number in them is a default of the merged policy, and an overlay may change it (`Overlays`, below); the resolver reads numbers from the policy, never from a literal.

### Strategies

Four public strategies: `quality`, `balanced`, `speed`, `economy`. They are the only values `--strategy` accepts.

`auto` is **not** a CLI value. Classifying a task is a skill decision: the orchestrating agent maps the task to one concrete strategy and calls the CLI with it. The rubric lives in this package's `skills/orchestrate` (PB-19) because it is harness-neutral; a consumer references it and adds only its own policy.

Weights, in percent:

| Strategy | Quality | Speed | Quota cost | Remaining |
|---|---:|---:|---:|---:|
| `quality` | 65 | 10 | 10 | 15 |
| `balanced` | 40 | 25 | 20 | 15 |
| `speed` | 20 | 60 | 5 | 15 |
| `economy` | 20 | 10 | 55 | 15 |

Three of the four inputs are maintainer ratings on the 1–5 scale and are normalised the same way:

```text
quality, speed   →  (r − 1) / 4 × 100
quotaCost        →  (5 − r) / 4 × 100      inverted: a smaller spend contributes more
```

The fourth is not a rating and never was. `remaining` is a percentage read from the availability snapshot:

```text
remaining        →  100 − max(usedPercent over the harness's applicable windows)
                    no windows, or the harness state is unknown → 50, and the candidate
                    additionally loses 10 points
```

A component of the total is its weight over 100 times the value above, so the four components sum to the base score and each can be divided back by its weight. The formula is a pure function, and every component is published in the decision output.

A call with no `--strategy` routes nothing: it takes today's path exactly, with today's defaults. Routing is opt-in.

### CLI surface

```text
promptobus models [--strategy <quality|balanced|speed|economy>] [--role <worker|reviewer>] [--refresh] [--json]
promptobus models validate
promptobus models --clear-exhausted <harness>
promptobus spawn  … [--strategy <…>] [--allow-payg]
promptobus review … [--strategy <…>] [--allow-payg]
```

Explicit `--harness`, `--model` and `--effort` are **constraints on the resolver, not wishes**. The CLI never silently replaces an explicitly named value: if the named combination is unavailable or exhausted, the command ends with diagnostics.

`--allow-payg` admits pay-as-you-go candidates.

`--dry-run` **reads the cache and nothing else**: no probe, no binary, no network, and no write. Live probes happen only when `--refresh` asks for them, and `--refresh --dry-run` probes but still writes neither cache nor task state. A snapshot that is stale or missing under `--dry-run` is reported in the decision — `stale_cache` on the harness and a warning — never silently taken as fact. The reason is that a dry run is the command a person uses to ask a question, and a question that starts three harness binaries and waits fifteen seconds is not one; the flag that costs time is the one that says so.

`--json` is a stable schema from its first version — pinned by a golden fixture before any resolver exists (PB-12).

The surface, its reason codes and its error codes are written into [03-cli](../reference/03-cli.md) once; nothing repeats that list.

### Catalog

The catalog unit is the tuple `role + harness + model + effort` — one rated row per thing that can be launched. A tuple carries:

- a stable `id`, and `harness`, `model`, `effort`;
- the roles it is allowed for;
- 1–5 ratings for `quality`, `speed` and `quotaCost`, with optional role-specific overrides. There are no effort modifiers: effort is part of the tuple key, so a level that rates differently is its own row, not a correction applied to a neighbour's.
- nullable USD prices per 1M input, cached input and output tokens;
- billing mode, `subscription` or `payg`;
- a canonical priority, used only as a tie-break;
- `assessedAt`, the source of the rating, and short evidence.

Maintainers of this repository keep the ratings. Updates are event-driven — a changed model line-up, changed prices, a substantial observation — not scheduled. A stale `assessedAt` produces a warning and never an exclusion.

**Only rated tuples enter auto-selection**, intersected with the models the current account actually exposes. A model the harness lists that the catalog does not rate is shown by `models` as an `unrated` runtime row and is never chosen automatically. Ratings are not invented: a rating without a source is a hypothesis and stays out of the catalog.

### Overlays

Layers, in precedence order:

```text
canonical catalog → host overlays, lowest to highest → CLI constraints
```

The **host** names the overlays and their order (`Host contract`, below). Standalone declares two, and they are the two the plan asks for:

| Layer | Standalone path | Whose it is |
|---|---|---|
| `user` | `~/.promptobus/model-routing.json` | the person's preferences, which follow the account across workspaces |
| `workspace` | `<workspaceRoot>/model-routing.local.json` | the person's local exception, for this repository set |

An overlay may change: strategy weights, penalties, bonuses, the reviewer quality floor, allow and deny lists for harnesses, models and efforts, ratings, canonical priority, and PAYG policy. A missing overlay file is normal, not an error.

**A consumer ships its policy — deny lists, defaults — as its own layer in that list, not inside the workspace overlay.** A consumer versions its policy with the product; written into the workspace overlay, every sync would either overwrite the person's edits or be overwritten by them. Its place is between `user` and `workspace`, and specificity is why: the user layer is a machine-wide preference that knows nothing about this workspace, the consumer policy is a property of the workspace they opened, and the workspace overlay is the person's local exception — which must be able to override the product, or a person could not try a denied model in one workspace without editing a product-shipped file. Because the host returns an ordered list rather than one path per layer, inserting that layer is a host-side choice and not a change to this contract.

**Clarification, 2026-09-05.** "Override" above means REPLACE, and only that: a higher layer states what a list is, and it cannot clear one. The overlay schema admits no empty list and no reset — `deny: {}` and `deny: { models: [] }` are both refused, and every denied name must exist in the merged catalog — so there is no way to write "deny nothing". A workspace overlay can therefore swap a ban for a different ban, but a ban written below it survives every file above that does not name that same selector kind. **A consumer policy ban holds whatever a person writes in their workspace file**, and that is the behaviour the first consumer wants: a product ships a ban and it stands. The cost is named rather than hidden: a person who wants to try one model their consumer forbids, in one repository, has to change the consumer's layer. This clarifies the decision recorded above; it does not reverse it, and no schema changes.

`promptobus models validate` checks schema, references to tuple, model and harness, rating ranges, weight sums, duplicate ids, and contradictory allow/deny rules.

### Availability snapshot

A probe returns one of four states — `available`, `exhausted`, `unavailable`, `unknown` — with a stable reason code, a human-readable message, `checkedAt`, its source, and a reset time when one is known.

Reason codes: `binary_missing`, `not_authenticated`, `subscription_exhausted`, `probe_timeout`, `probe_failed`, `quota_unknown`, `stale_cache`, `manual_exhaustion`.

`model_not_available` is the narrow one, and it is worth saying why. The state in this snapshot is the HARNESS's, so a harness marked `unavailable` takes every one of its tuples with it. That is right for a missing binary and for a missing login; it is wrong for a model. A model the account does not expose excludes one tuple and leaves the harness's other tuples alone — the decision reports that per candidate, as `model-not-in-inventory`. `model_not_available` therefore appears only on the explicit `--model` constraint path, where the person named the model and there is nothing else to fall back to, and it never makes the harness `unavailable`.

**Note (2026-09-05, PB-21.1): the decision above is unchanged, and `model_not_available` is gone from the list because of it.** What this decision fixes — that a model the account does not expose is a PER-TUPLE fact, reported per candidate as `model-not-in-inventory`, and never a harness-level `unavailable` — stands exactly as written and is what the implementation does. The code was the one part of the paragraph that had nowhere to live under its own rule: a snapshot entry carries a state, that state is the harness's, and the only state the code could ever have accompanied is the `unavailable` this paragraph forbids for a model absence. Nothing in the tree ever wrote it. So the list above names the eight codes that are shipped — the same eight as `schemas/model-routing/snapshot.schema.json`, `AVAILABILITY_REASONS` and the reference table, which move together — and the paragraph below is kept as the reasoning that decided both the rule and the removal. This is a clarification of this decision, not a reversal of it: nothing that was accepted here is being undone, and no superseding ADR is needed.

Probes run in parallel under a **15 s total budget** for the whole preflight; an adapter that misses it reports `probe_timeout` and does not hold the command.

TTLs: auth and model inventory 1 h; limit data 60 s; confirmed exhaustion until the known reset; exhaustion with no known reset until an explicit `--clear-exhausted`; a transient failure 5 min. `--refresh` ignores matching entries and probes again; it is also the only way a probe runs under `--dry-run`.

The cache file is named by the host (`Host contract`, below) and is mode `0600`. It sits under the **user** home, not under `promptobusHome()`: what it caches — auth, model inventory, remaining limit — belongs to the account, not to one workspace, and a per-store copy would re-probe three harnesses for every checkout of the same account. Standalone answers `~/.promptobus/model-routing/cache.json`.

It holds **no prompt, no token, no email and no open account id**. If accounts must be told apart, the key is an opaque local fingerprint from which the original identifier cannot be recovered.

Three adapters are in v1 — Claude, Cursor and Codex. An adapter that cannot obtain a remaining limit from a stable source returns `unknown`; it never models an exact value.

### Resolver

Filtering, in this order:

1. tuples from the merged catalog;
2. allow/deny policy and explicit CLI constraints;
3. drop tuples not rated for the role being routed (`role-not-allowed`);
4. drop tuples whose model the account does not expose. A model with no catalog rating never reaches this list at all — it is not a tuple, and it is reported separately as a runtime row;
5. drop `unavailable` and `exhausted`;
6. drop PAYG unless `--allow-payg`;
7. score what is left;
8. apply the reviewer rules;
9. pick by the stable tie-break.

`unknown` is penalised, not blocked: its `remaining` counts as a neutral 50 % and the candidate loses a further 10 points, and the decision carries a warning.

Extra rules: minus 5 points for every live participant already on that harness, capped at 20; a reviewer quality floor of 4 out of 5; if no reviewer candidate reaches the floor, the best remaining one is chosen with a warning — a soft fallback, not a refusal; a reviewer whose harness or model differs from the worker's gains a diversity bonus of 5.

Tie-break, in order: effective score → confirmed availability → canonical priority → tuple id. It is total: two tuples cannot share an id, so the resolver is deterministic on the same inputs regardless of input order.

Every considered candidate — chosen or excluded — appears in the decision with its state, its score components and its exclusion reason.

### Start behaviour

**No task, worktree or participant is written before a candidate exists.** Routing joins the gate order `lib/spawn.js` already states for `liftHarness` and `resolveEffort` — "two gates, both before any write to disk" (line 281) — and a run with no candidate ends there, leaving the store exactly as it was.

Inside the strategy envelope a preflight exclusion moves to the next candidate without asking the person again: they approved the envelope, the harness allowlist and the PAYG policy, and the fallback stays inside it. Leaving the envelope needs a new approval.

If a limit is hit between preflight and the actual start, the command ends with exact diagnostics, the cache marks that tuple or harness exhausted, and the next attempt may pick another candidate. **There is no automatic rollback and retry inside the same command**: a command that silently restarted itself would hide from the person the fact that the account they chose is out.

Routing applies only before liftoff. Once a participant is live its harness and model are fixed.

### Participant metadata

The decision — strategy, tuple, score, snapshot age, warnings, whether constraints applied — is kept in the participant's `metadata`. That field is opaque to the core by construction: `src/protocol.ts` line 199 says of the participant record "everything else about the participant is written by the adapter and lives in `metadata`, which core does not look into", and the field itself is declared at line 212. `status` reads the routing decision through the accessor pattern the same file already establishes, not through scattered `p.metadata.<field>` reads.

**The protocol version is not raised.** `metadata` is declared open in `schemas/v1/participant.schema.json`; a record carrying a routing decision is readable by a mechanism of any version, which is exactly what that field exists for.

### Host contract

Two facts the host already answers, and no new method is added for either:

- `declaredTools()` — which harnesses this workspace declared. The routing catalog is filtered by it, exactly as `--harness` is (`lib/spawn.js` `liftHarness`).
- `resolveToolBin(name)` — how to launch a harness binary, and whether it is there at all. An adapter reports `binary_missing` from its verdict rather than searching `PATH` itself.

One fact the host does not answer yet, added by this decision to `src/host.ts` with its doc comment and answered by `createStandaloneHost`:

```ts
routingPaths(): { cacheFile: string; overlays: Array<{ id: string; path: string }> };
```

`overlays` is ordered **lowest precedence first**; `cacheFile` is the availability cache. Standalone answers the cache file and the two layers of the table above.

One method with an ordered list, rather than one getter per layer, for a reason the two-getter shape cannot meet: a consumer will want a layer of its own between the person's two, and with a list that is a host-side choice — with getters it is another change to this interface, and every consumer repins for it. The `id` is what the decision output and `models validate` name a layer by, so a diagnostic reads `denied by overlay "workspace"` rather than a path the person has to place themselves.

`promptobusHome()` is **not** used for routing. It stays what it is — the store home, per workspace — while every routing path is account-scoped and comes from `routingPaths()`.

A host method named only in prose is the drift this package has already paid for once — the `bin` field of `HostToolBin` carries that story in its own doc comment (`src/host.ts`, the comment opening at line 69 above `bin?: string` at line 82). Hence the rule: nothing in this ADR names a host method that does not exist in `src/host.ts` at the same commit.

### Skills integration

The `auto → concrete strategy` rubric, the strategy envelope agreed with the person before the first spawn, and the reviewer's default strategy live in this package's `skills/` (PB-19). A consumer references them and adds only its own policy — which models it forbids, which harness its reviewer stays on. `promptobus status` shows the chosen strategy, tuple, snapshot age and warnings for each routed participant, so the envelope is auditable during the run and not only at its start.

## Decisions the owner confirmed

The table was written as if these defaults hold, and the owner confirmed all four rows on 2026-09-05, which is what moved this ADR to Accepted. The right-hand column is kept: it is the cost of reversing a row, and a later decision that wants to reverse one starts by reading what it would pay.

| # | Question | Default recorded here | If the owner reverses it |
|---|---|---|---|
| 1 | Does PAYG take part in automatic selection? | **No.** PAYG candidates are excluded unless `--allow-payg` is passed. | One filter step in the resolver drops out and the flag becomes an opt-*out*; the money-cost fields of the catalog start to matter on every run. |
| 2 | Is the reviewer quality floor a constant or a policy value? | **A policy value**, default 4 of 5, overridable by an overlay, with a soft fallback and a warning when nothing reaches it. | A constant removes one overlay key and makes the floor unreachable for a consumer whose reviewer runs on a deliberately cheaper harness. |
| 3 | How many locally authenticated accounts per harness does v1 assume? | **One.** The adapters probe the account the binary is logged into and nothing else. | Every probe, every cache entry and the tuple key gain an account dimension, and the cache-privacy rule (opaque fingerprint) becomes load-bearing rather than a precaution. |
| 4 | What does an unknown remaining limit do? | **Penalises**: neutral 50 % remaining, minus 10 points, warning in the decision. | Blocking makes `unknown` fatal, and since no harness exposes a stable quota API for all three accounts, most runs would have no candidate at all. |

## Not in v1

Repeated from the plan, so that a later reader does not read an omission as an oversight:

- changing the harness or model of a participant that is already running; mid-run migration and handoff;
- more than one account per harness;
- ratings derived automatically from telemetry, and EWMA latency scoring;
- automatic purchase or enabling of PAYG;
- exact quota accounting where the provider gives no stable API;
- routing for the orchestrator itself — it stays in the session the person started.

## Consequences

- **The contract is testable before it is implemented.** Schemas and golden fixtures land first (PB-12); the tasks after them implement against pinned shapes instead of inventing them. The cost is that a shape wrong here is wrong in nine places.
- **A pick must be explainable.** Every candidate, score component and exclusion reason is published. A resolver that cannot say why it chose is a regression, not an optimisation.
- **Determinism is load-bearing.** The tie-break ends at the tuple id, so two runs on the same snapshot pick the same tuple. Anything that makes the resolver read wall-clock time or iteration order breaks this decision.
- **The package gains a data file it must maintain.** Ratings go stale, and a stale rating is only a warning — so an unmaintained catalog degrades quietly rather than loudly. That is the price of not blocking on it.
- **The cache is the one new file that can leak.** It holds availability, not identity, and the `0600` and no-secrets rules are gates in PB-14, not intentions.
- **Legacy behaviour is a test, not a promise.** A call without `--strategy` takes today's path; the check for that is green from PB-12 onward, before any routing code exists.
