# ADR-005: Model routing, subscription balance, and ratings on a 1–10 absolute scale

**Status:** Accepted
**Date:** 2026-09-05
**Deciders:** the repository owner. Routing defaults were confirmed on 2026-09-05. The nine subscription-balance decisions were confirmed on 2026-09-06. The ten-point absolute bands and local calibration were confirmed when the first catalog pass showed that relative rank bands could not be applied to the published field. Hidden inventory rows were kept as shipped on 2026-09-10. The near-limit exclusion was decided on 2026-09-26. An explicit `--model` the catalog does not rate was made a lift rather than a refusal on 2026-09-28.

## Context

A routed run names an intent — a strategy — and the CLI picks one `role + harness + model + effort` tuple from a rated catalog intersected with what the local account can run, explains the pick, and never silently replaces an explicit `--harness`, `--model` or `--effort`.

Three subscriptions pay for three harnesses. Scoring by rating alone spends the best-rated tuple until one account is out. A spike on 2026-09-06 showed every harness can answer what it can run and how much of its window is gone, from local credentials and with no paid turn.

Ratings started on a 1–5 scale with relative rank bands over a changing field. The first catalog pass exposed the field defect at the top: two models one published point apart shared the highest band. Absolute bands remove the field. Local telemetry can propose a bounded correction without becoming the catalog.

The operational surface — flags, reason codes, schemas — is [03-cli § Model routing](../reference/03-cli.md#model-routing). This ADR is the decision that surface implements. The guide is [model routing](../guides/model-routing.md).

## Decision

**1. Five strategies, opt-in unless an overlay sets a default.** `quality`, `balanced`, `speed`, `economy` and `balance` are the only values `--strategy` accepts. `auto` is a skill decision in `skills/orchestrate`, never a CLI value. Weights, in percent:

| Strategy | Quality | Speed | Quota cost | Remaining |
|---|---:|---:|---:|---:|
| `quality` | 65 | 10 | 10 | 15 |
| `balanced` | 40 | 25 | 20 | 15 |
| `speed` | 20 | 60 | 5 | 15 |
| `economy` | 20 | 10 | 55 | 15 |

`balance` has no weight set of its own. Inside one harness it orders tuples by the merged `balanced` weights. An overlay that re-weights `balanced` re-weights the inside of `balance` with it.

Ratings normalise on the 1–10 scale:

```text
quality, speed   →  (r − 1) / 9 × 100
quotaCost        →  (10 − r) / 9 × 100
remaining        →  100 − max(usedPercent over the tuple's applicable windows)
                    no windows, or the harness state is unknown → 50, and the candidate loses 10
```

Applicable windows are the account-wide ones plus the scope that covers that tuple, so `remaining` is per tuple under every strategy. A component is its weight over 100 times the value above. The formula is a pure function and every component is published.

Precedence: `--strategy` on the command line, then the merged `defaults.strategy` (a scalar; the highest layer that states one wins), then nothing. With no default anywhere, a call with no `--strategy` routes nothing. A lift routed by the default records `strategySource: "overlay:<layer>"`. A flag records no source.

**2. The catalog unit is the tuple** `role + harness + model + effort`, with a stable `id`, the roles it is allowed for, integer 1–10 ratings for `quality`, `speed` and `quotaCost` (optional role-specific overrides; no effort modifiers), nullable USD prices per 1M tokens, billing mode `subscription` or `payg`, a canonical priority used only as a tie-break, `assessedAt`, and evidence. Only rated tuples enter auto-selection, intersected with the models the account exposes. An unrated model is an `unrated` runtime row and is never chosen. A stale `assessedAt` warns and never excludes. Maintainers update the catalog when the line-up, the prices or a substantial observation changes, not on a calendar.

**3. Absolute bands, not a field.** For each model, take the first published figure for that exact model: SWE-bench Verified, then Terminal-Bench, then Aider polyglot, then the vendor model card. Map it with a dated anchor pair for that benchmark version and agent harness.

### Absolute bands

For a measurement `x`, floor anchor `floor` and ceiling anchor `ceiling`:

```text
band = clamp(1 + roundHalfUp((x − floor) / (ceiling − floor) × 9), 1, 10)
```

All measurements are non-negative, so `roundHalfUp(y) = floor(y + 0.5)`. Values outside the anchors clamp. Each anchor pair identifies the benchmark, version and agent harness, and carries the date on which the pair was assessed. A figure without all three is not a figure. When several figures exist, use the harness this catalog runs the model on; if none does, use the highest published figure and say that this fallback was used.

There is no field. Adding or removing a rated or exposed model changes no other model's band. The catalog pass of 2026-09-06 fixes these anchors. They are revisited on every catalog update, not on a calendar. Changing an anchor is a catalog-wide re-band and changes `assessedAt`. These anchors replace banding, not source selection.

Terminal-Bench 2.1 deliberately uses one numeric pair, 60 → 90, for every harness. The harness identifies the figure; it is not a separate judgement about the scale.

Terminal-Bench 4.0 uses a 40 → 60 pair for Claude Code. The public leaderboard reports GLM-5.3 at 41.8 % ±3.2 (released 2026-08-14) at the floor side and Fable 5.1 at 57.9 % ±3.8 (released 2026-09-01) at the ceiling side; those rows support the rounded pair assessed 2026-09-09. Those 4.0 figures have no Codex anchor pair and band nothing: a 4.0 Codex figure is not computed from the Claude Code pair.

| Rating | Source, version | Agent harness | Floor → 1 | Ceiling → 10 | Assessed |
|---|---|---|---:|---:|---|
| `quality` | SWE-bench Verified | the harness named by the source | 60 % | 96 % | 2026-09-06 |
| `quality` | Terminal-Bench 2.0 | Cursor agent | 50 % | 85 % | 2026-09-06 |
| `quality` | Terminal-Bench 2.0 | Codex CLI or not stated | 50 % | 85 % | 2026-09-06 |
| `quality` | Terminal-Bench 2.1 | Claude Code | 60 % | 90 % | 2026-09-06 |
| `quality` | Terminal-Bench 2.1 | Codex CLI | 60 % | 90 % | 2026-09-06 |
| `quality` | Terminal-Bench 2.1 | Vals AI | 60 % | 90 % | 2026-09-06 |
| `quality` | Terminal-Bench 2.1 | Terminus 2 | 60 % | 90 % | 2026-09-06 |
| `quality` | Terminal-Bench 2.1 | mini-SWE-agent | 60 % | 90 % | 2026-09-06 |
| `quality` | Terminal-Bench 2.1 | single-agent or not stated | 60 % | 90 % | 2026-09-06 |
| `quality` | Terminal-Bench 4.0 | Claude Code | 40 % | 60 % | 2026-09-09 |
| `speed` | Artificial Analysis output speed | Artificial Analysis serving stack | 40 tokens/s | 310 tokens/s | 2026-09-06 |
| `quotaCost` | blended public list price `(input + output) / 2` | vendor API | $2.50 / 1M tokens | $30.00 / 1M tokens | 2026-09-06 |

The Terminal-Bench 4.0 pair bands models whose only published figure is a 4.0 one. A figure from a different benchmark, version or agent harness than the source triple on which a predecessor's band rests is recorded in `evidence.text` with its computed band but cannot demote the corresponding effort rung when vendor-published head-to-heads put the successor ahead on every comparison. The hypothesis remains until the successor has a figure from the predecessor's source triple.

For `quotaCost`, the arithmetic is applied in the price direction: the cheap anchor is band 1 and the dear anchor is band 10. Scoring still inverts that band. The floor is a round stable list-price anchor near the cheapest cited list price ($2.63 for GPT-5.4 Mini), not a temporary promotional blend. A promotion applies to that model's figure only while the cited promotion is in force; it does not move the anchor or force unrelated rows to re-band.

A row with no assessment is omitted. An assessed rating without a published figure stays in the catalog and is named in `evidence.hypothesis`. `validate` refuses a rated row with neither a source, nor an interpolation from a base row, nor a stated hypothesis.

`speed` is published output throughput and is constant across the effort ladder. `quality` and `quotaCost` each move one band per effort step away from the measured base rung, clamped to 1…10. Every rung is kept. A warning names rungs the coarse rating cannot distinguish. `quotaCost` is inverted so the cheapest model takes the low band. The service tier beside a Codex effort is not an effort and is not a tuple dimension. Cursor rows exist only for models Claude Code and Codex do not serve.

**4. Overlays.** Precedence is canonical catalog, then host overlays from lowest to highest, then CLI constraints. An overlay may change weights, penalties, bonuses, quality floors, allow and deny lists, ratings, canonical priority and PAYG policy. A missing file is normal.

`deny` accumulates: a ban written in any layer stands, and no layer above it lifts it. `allow` intersects: a tuple must be named by every allow list of that kind that any layer states. `models validate` reports `allow-intersection-empty`, `deny-covers-allow`, and the warning `allow-shadowed-by-deny`. A name allowed and denied in one layer stays an error. The command prints, per denied selector, the layer that wrote it and that only that layer can lift it.

Two selectors are additive, in `allow` and `deny`: `byRole` (a nested block for `worker` or `reviewer`, not a flat list) and `flags` (a mark the snapshot carries; today `no-zdr`). Flags are checked against the snapshot schema's enum, not the catalog. A flag no snapshot in this run set is a warning. A harness that reports no inventory has no flags to match, so a flag deny excludes nothing there.

Catalog and overlay `schemaVersion` are both 2 (`lib/model-routing/catalog.js`, `CATALOG_SCHEMA_VERSION` and `OVERLAY_SCHEMA_VERSION`). A catalog on any other version is refused. A v1 overlay is read only when it carries none of `ratings`, `qualityFloor` and `reviewerQualityFloor`. A v1 overlay that carries any of those three is refused by load and by `models validate`; the route is to rewrite them on the 1–10 scale and set `schemaVersion` 2. A v1 overlay with none of them stays valid: deny and allow lists, weights, penalties, bonuses, priority, `payg`, defaults and account data did not change shape. A workspace overlay that used to replace a deny list below it now accumulates with it.

**5. Exactly one writable layer.** When a host declares any layer, exactly one is `writable`; `readLayers` refuses zero and refuses two. Standalone answers `workspace` at `<promptobusHome>/model-routing.json` and it is the writable one. `user` stays under the user home. `<workspaceRoot>/model-routing.local.json` is not read, and there is no fallback. The cache stays account-scoped at `~/.promptobus/model-routing/cache.json`, mode 0600, and holds no prompt, no token, no email and no open account id. `models calibrate --write` is the one exception that writes the `user` layer, and only agreed `ratings`. A consumer's product-policy layer stays read-only and is not a committed file the tool rewrites. `routingPaths()` returns `{ cacheFile, overlays }` ordered lowest precedence first. `promptobusHome()` is the store home; the workspace overlay lives there because the tool writes it, not because routing became per-store for the cache.

**6. The snapshot** is `schemaVersion` 2. A v1 document is discarded rather than migrated: every harness reports `unknown` / `stale_cache`, and the next run probes. A window is `{ id, kind, lengthSec, usedPercent, resetAt, scope }` with `kind` one of `session`, `weekly`, `monthly`. `kind` is a name, not a length. `scope` is `null` (the whole account), `{ model, models? }` or `{ pool: "auto" | "api", models? }`. The resolver matches by exact id and infers no family. `models` is required on an `auto` pool and refused on an `api` pool. A tuple whose model is in no `auto` list falls in the `api` pool. An unresolved display name stays in the snapshot, is printed, and binds nothing.

A harness gains `tier: { name, source } | null`. `source` is `credentials`, `probe`, `derived` or `user`. The tier is displayed and is an input to no score. It follows the auth TTL (one hour); windows keep sixty seconds. Codex `credits`, `spendControlReached` and the full-reset credit count are informational. Nothing spends a reset credit.

A model gains `hidden: boolean`. A hidden row is carried in the snapshot so the cache matches what the harness lists. The resolver's inventory and the `runtime` list are the rows with `hidden !== true`. A catalog tuple naming a hidden model is excluded as `model-not-in-inventory`.

States: `available`, `exhausted`, `unavailable`, `unknown`. Reason codes: `binary_missing`, `not_authenticated`, `subscription_exhausted`, `probe_timeout`, `probe_failed`, `quota_unknown`, `stale_cache`, `manual_exhaustion`. A model the account does not expose is per tuple (`model-not-in-inventory`), never a harness-level `unavailable`. `model_not_available` is not a snapshot reason. Probes run in parallel under a 15 s total budget. TTLs: auth and inventory 1 h; limit data 60 s; confirmed exhaustion until the known reset, or until `--clear-exhausted` when no reset is known; a transient failure 5 min. An adapter that cannot obtain a remaining limit returns `unknown` and never invents one. Three adapters are in v1: Claude, Cursor and Codex. One locally authenticated account per harness.

**7. `balance` is a choice layer, not a filter.** Filtering steps below run unchanged. Each surviving candidate gains a pace block in percentage points of the binding window — the applicable window with the highest `usedPercent`:

```text
underspend    (elapsedShare − usedShare) × 100
spendPenalty  balance.spendUnit × (quotaCost − 1) / 9
effective     underspend − spendPenalty
```

`elapsedShare` is clamped to 0…1. A window whose `resetAt` is absent or not in the future is not paced. `balance.band` and `balance.spendUnit` default to 5. The pick groups eligible candidates by `(harness, pool)`. When any representative meets the role's quality floor, only those enter the leader band; within `balance.band` of the leader the `balanced` score decides, then confirmed availability, canonical priority, tuple id. When none meets the floor, all representatives stay eligible and the warning is `worker-floor-not-met` or `reviewer-floor-not-met`. No eligible candidate falls back to the best `balanced` score with `balance-fallback`. A below-floor representative taken while a floor-meeting candidate could not be paced names both tuples in that warning.

**8. Quality floors are policy, and they are choice rules, not filters.** Defaults on the 1–10 scale: worker 5, reviewer 9 (`src/registry.ts`). The approver floor of 7 is [ADR-024](adr-024-approver-acceptance-in-own-worktree.md). `qualityFloor: { worker, reviewer }` in an overlay; `reviewerQualityFloor` remains an alias for `qualityFloor.reviewer`, and the explicit key wins. A candidate below the floor keeps its score. When nothing reaches the floor the best remaining candidate is taken with a warning. Nothing in this package pins the reviewer to a harness. A reviewer whose harness or model differs from the worker's gains a diversity bonus of 5.

**9. Resolver order.** Merged catalog; allow/deny and CLI constraints; drop `role-not-allowed`; drop models the account does not expose; drop `unavailable` and `exhausted`; drop PAYG unless `--allow-payg`; score; apply the role floors and the diversity bonus; stable tie-break: effective score, confirmed availability, canonical priority, tuple id. `unknown` is penalised (remaining 50, minus 10), not blocked. Minus 5 points for every live participant already on that harness, capped at 20. A tuple whose binding window is at or past `nearLimit.excludeAtUsedPercent` (default 90) leaves automatic selection as `window-nearly-spent`, unless `--harness` or `--model` names it, which passes it with `window-nearly-spent-named`. `--effort` alone names no account. When every account is past the threshold, a lift refuses as `candidates-empty` rather than falling back. An `unknown` harness is still penalised and never excluded by this rule.

**10. Near-limit signal.** `models` warns when a binding window is at or past `nearLimit.usedPercent` (default 80) or underspend is below `nearLimit.underspend` (default −15). A harness already `exhausted` is not repeated. `economy` is proposed when every paced harness is short by either test; `balance` otherwise. No line is printed when that strategy is already running. `models strategy --set` writes `defaults.strategy` into the writable layer and warns when a higher layer shadows it. The rubric proposes the switch; the person decides. Nothing changes strategy by itself.

**11. One question the tool cannot answer.** Cursor's plan name lives in the user overlay under `account: { "<harness>": { "plan": "<name>" } }`. No command writes it. The snapshot keeps the measured derived tier; `models` prints the person's answer beside it. A typed string never enters the cache.

**12. CLI constraints and dry run.** Explicit `--harness`, `--model` and `--effort` are constraints. A lift whose `--model` no tuple of the merged catalog names is not routed: a model released after this package's catalog runs without a package update. It lifts with the id as typed, on `--harness` or the default harness, as a lift with no strategy does, and the harness binary accepts or refuses the id. With `--harness`, unrated means that no tuple on that harness names the model. The allow and deny lists in force for the step still apply, under the typed id and the one id a driver alias resolves to. The marks for a flag rule come from the availability snapshot row of that model. A lift with no tuple cannot meet `allow.tuples`. Without a snapshot row, it cannot meet `allow.flags` either. A missing row leaves `deny.flags` unchecked, with a warning, as the resolver treats a harness that lists no models. `--allow-payg` admits pay-as-you-go candidates; without it PAYG is excluded. `--dry-run` reads the cache and nothing else. `--refresh` is the only probe, and `--refresh --dry-run` probes but writes neither cache nor task state. A stale or missing snapshot is reported, never taken silently as fact. `--json` is the decision document. No task, worktree or participant is written before a candidate exists. Inside the strategy envelope a preflight exclusion moves to the next candidate without asking again. There is no automatic rollback and retry inside the same command. Routing applies only before liftoff.

**13. Participant metadata.** The decision is kept in `metadata.routing`. The protocol version is not raised: `metadata` is open in `schemas/v1/participant.schema.json`.

**14. Host methods this decision uses, and no others.** `declaredTools()`, `resolveToolBin(name)`, `routingPaths()`. An adapter reports `binary_missing` from the host's verdict rather than searching `PATH` itself.

**15. `models calibrate`.** Every band it compares against is the shipped catalog's, never the merged stack's. Running it twice on one telemetry file proposes the same thing twice. The evidence threshold is 5 runs per key for `quotaCost`, and five usable throughput observations pooled per `(harness, model)` for `speed`. The eligible key with the most runs is the local anchor for `quotaCost` and keeps its catalog bands; a tie keeps the earlier key in lexicographic `(harness, model, effort)` order. The most-observed model with enough throughput observations is the speed pivot; one speed proposal applies to every rated effort rung of that model. A one-band difference implies a factor of 1.25. A surprise of at least 1.5× moves one band; at least 3× moves two. One run is capped at ±2 and clamps to 1…10. `speed` moves up when throughput is unexpectedly higher; `quotaCost` moves up when the window delta is unexpectedly higher. A zero or missing denominator omits that rating, and so does a measured zero throughput. Completion `durationSec` is printed and is never used to calibrate `speed`. On 2026-09-10 the owner decided that `speed` means published output throughput. `quality` is never proposed. `--write` merges only the ratings that moved into the host layer whose id is `user`, per tuple and per rating, and raises a version-1 overlay to `schemaVersion` 2. Without a TTY the command refuses unless `--yes` is also present. `--yes` is valid only with `--write`. Under `--json` every refusal happens before the one document is printed.

The pace divisor is 9 because a rating is an integer from 1 to 10. `lib/model-routing/resolver.js` computes `spendPenalty` as `spendUnit * (quotaCost - 1) / 9`.

## Owner confirmations that still hold

| Question | Decision |
|---|---|
| Does PAYG take part in automatic selection? | No, unless `--allow-payg`. |
| Is the reviewer quality floor a constant? | No. It is policy, default 9 of 10, with a soft fallback. |
| How many local accounts per harness? | One. |
| What does an unknown remaining limit do? | Penalises: remaining 50, minus 10, and a warning. |
| Does the reviewer take part in `balance`? | Yes. Which harness a reviewer stays on is a consumer rule, not a package rule. |

## Not in v1

- Changing the harness or model of a participant that is already running.
- More than one account per harness.
- A telemetry-derived `quality` rating, or applying a calibration proposal without `--write` and explicit agreement.
- Writing calibrated ratings into the shipped catalog or any non-user layer.
- Automatic purchase or enabling of PAYG, and spending a reset credit.
- The tier as an input to any score.
- Codex service tier as a tuple dimension.
- Any automatic change of strategy.

## Consequences

- A catalog rating is stable under field membership. Its anchors are maintainer judgements and every catalog update is also an anchor review. Rating overrides written on 1–5 must be rewritten; policy-only overlays on schema version 1 keep loading.
- Resolver weights keep their relative importance. Golden decisions move because a rating's numeric representation moved from a 4-wide scale to a 9-wide one.
- A ban is permanent from below. An allow list can intersect to nothing, and `models validate` names both layers.
- The workspace overlay left the repository. A file at `model-routing.local.json` is no longer read. There is no migration.
- `balance` is only as good as the windows. The Claude usage endpoint and the Cursor dashboard method are not published contracts; a shape change makes those harnesses `unknown`, and `balance-fallback` is what keeps that from being silent.
- Local telemetry can challenge the catalog only through a confirmed user overlay. Relative local anchors are printed beside every proposal.
- Reviewer eligibility cannot be created by interpolation. A base assessment that does not itself reach 9 does not become a reviewer by stepping the ladder.
