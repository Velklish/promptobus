# ADR-005: Ratings on a 1–10 scale with absolute bands and local calibration

**Status:** Accepted
**Date:** 2026-09-06
**Deciders:** Pavel Kim (project owner)
**Supersedes:** [ADR-003](adr-003-model-routing.md) and [ADR-004](adr-004-subscription-balance.md), only where the table below says so

## Context

[ADR-004](adr-004-subscription-balance.md) put `quality`, `speed` and `quotaCost` on a 1–5 scale and cut relative rank bands over a changing field. The first catalog pass exposed five defects, recorded in PB-29.1.

1. A benchmark version changes the meaning of a figure. The same Grok 4.6 was reported at 88.4 on Terminal-Bench 2.1 and 26 on 3.0.
2. The agent harness is part of the figure. Claude Fable 5 scores 83.8 with Claude Code and 80.4 with Terminus 2 on Terminal-Bench 2.1; Gemini 3.8 Flash was reported at 90.8 and 19.1 ± 3.4 under different harnesses.
3. There is no reproducible field whose five equal ranks both discriminate at the top and stay fixed when a neighbouring model is added or removed. Therefore this decision has **no field definition**: absolute bands do not read a field.
4. Published output throughput is a property of a model and serving stack, not its reasoning effort. Interpolating `speed` along an effort ladder mixed throughput with time to a completed answer.
5. Upward interpolation could make an unmeasured rung a reviewer. `codex-gpt55-xhigh` was the live case.

The 1–5 ceiling made the field defect visible at the top: Opus 5 at 96.0 and Fable 5 at 95.0 necessarily shared the highest band, while a relative split would have separated two models only one point apart. At the same time PB-36 began writing local `telemetry.jsonl`, but nothing read those records back. A person could see that a local serving stack or subscription behaved unlike the shipped catalog and had no reproducible way to turn the observation into an overlay correction.

PB-29.1 also found a wording defect. A hypothesis is not omitted merely because no publisher supplied a number. A catalog row is omitted only when maintainers have made **no assessment**. An assessed rating without a published figure stays in the catalog, explicitly named in `evidence.hypothesis`, so the model is not silently removed from automatic routing.

## Options

### Decision 1 — scale and bands

- **1A. Keep 1–5 relative ranks.** No migration, but the five defects remain.
- **1B. Use 1–10 absolute bands with dated anchors.** A row does not move when a neighbour appears, and the top of the field has ten steps. The anchors are maintainer decisions and can go stale.
- **1C. Keep raw benchmark figures in the resolver.** Avoids bands but makes unlike benchmarks, throughput and subscription spend look commensurable and turns the resolver into a benchmark adapter.

### Decision 2 — half values

- **2A. Round half up.** `n + 0.5` becomes `n + 1`; this is the familiar reading of “round” for the non-negative measurements used here.
- **2B. Round half to even.** Reduces aggregate bias but makes an individual boundary depend on whether the lower integer is odd or even.
- **2C. Admit decimal ratings.** Appears more precise than the evidence and widens every schema and comparison.

### Decision 3 — quality interpolation on the wider scale

- **3A. One band every two effort steps.** Preserves the old integer arithmetic but halves the normalised effect, from one quarter of the old scale over two steps to one ninth of the new scale.
- **3B. One band per effort step.** Over two steps the normalised movement is `2 / 9`, close to the old `1 / 4`, and every adjacent rung remains distinguishable until it clamps.

`speed` has no effort step at all, so the only other ladder question is `quotaCost`.

### Decision 3a — the `quotaCost` step

One effort step changes the token budget directly, so whatever the size, the sign follows the step.

- **3a-A. Two bands per step.** Preserves the OLD RELATIVE step: `2 / 9` of the new scale is the closest integer movement to ADR-004's `1 / 4`. Its cost is the clamp — a five-rung ladder spans eight bands, so both ends of a long ladder run into 1 and 10 and stop meaning anything. `claude-opus-medium` came out at `quotaCost` 1, the same band as `gpt-5.4-mini` at $2.63 blended, which says a top-tier model at medium effort spends as little of the subscription as the cheapest model in the catalog.
- **3a-B. One band per step.** `1 / 9` per step, a little under half the old effect. A ladder spans as many bands as it has rungs, so it stays inside the scale and the ordering between models survives at both ends. It states less about how much one effort step costs, which is the honest position: the step size was never measured, and `models calibrate` is what will argue with it from real runs.

The owner chose 3a-B on 2026-09-06, reading the table: the ladders under 3a-A were too steep, and the case that showed it is the `claude-opus-medium` / `gpt-5.4-mini` collision above. Preserving a relative step size from a scale that was just replaced is worth less than keeping the absolute bands comparable across models, which is what the whole decision is for.

### Decision 4 — incomplete telemetry

- **4A. Treat every record identically.** Simple, but a dismissed run's duration is not time to an accepted piece and a record without windows cannot say what the run spent.
- **4B. Keep the run, use only the measurements it actually contains.** A dismissed record counts as a run and its window deltas remain spend evidence, but it is excluded from duration, turns and review rounds per accepted piece. A record without windows counts as a run and as completed-work evidence when otherwise complete, but contributes no window delta.
- **4C. Drop incomplete records whole.** Makes the surviving medians clean by throwing away real subscription spend and biasing the sample toward successful work.

### Decision 5 — `calibrate --write` without a terminal

- **5A. Refuse every non-interactive write.** Safe, but prevents an already approved automation from applying the exact printed proposal.
- **5B. Require `--yes` when stdin is not a TTY.** Interactive use still asks for explicit confirmation; automation has an auditable consent flag.
- **5C. Let `--write` imply consent.** Convenient, but the command could mutate a person's account-scoped file merely because a wrapper forwarded a flag.

### Decision 6 — turn local measurements into a bounded correction

- **6A. Make the local minimum and maximum bands 1 and 10.** With two eligible keys they become opposite extremes however small their difference; this repeats the relative-field defect removed from the catalog.
- **6B. Anchor on the most-observed eligible catalog row and correct surprises by fixed ratios.** The pivot keeps its catalog band. Other rows move only when their measured ratio differs materially from the ratio implied by their catalog bands, and one calibration is capped at two bands.
- **6C. Print measurements without proposed ratings.** Honest, but it does not deliver the overlay lines the command exists to produce.

## Decision

The owner chose 1B: integer ratings from **1 through 10**. Option 2A fixes rounding, option 3B fixes quality interpolation, option 3a-B fixes the `quotaCost` step, option 4B fixes incomplete records, option 5B fixes non-interactive writes, and option 6B keeps local proposals anchored to the shipped catalog.

### Absolute bands

For a measurement `x`, floor anchor `floor` and ceiling anchor `ceiling`:

```text
band = clamp(1 + roundHalfUp((x - floor) / (ceiling - floor) × 9), 1, 10)
```

All measurements are non-negative, so `roundHalfUp(y) = floor(y + 0.5)`. Values outside the anchors clamp. Each anchor pair identifies the benchmark, version and agent harness, and carries the date on which the pair was assessed. A figure without all three is not a figure. When several figures exist, use the harness this catalog runs the model on; if none does, use the highest published figure and say that this fallback was used.

There is no field any more. Adding or removing a rated or exposed model changes no other model's band. This closes PB-29.1's field-size and field-reproducibility defects.

The catalog pass of 2026-09-06 fixes these anchors. They are revisited on every catalog update, not on a calendar. Changing an anchor is a catalog-wide re-band and changes `assessedAt`. ADR-004's primary-figure order remains unchanged: SWE-bench Verified, then Terminal-Bench, then Aider polyglot, then the vendor model card. These anchors replace banding, not source selection.

Terminal-Bench 2.1 deliberately uses one numeric pair, 60 → 90, for every harness. The harness identifies the figure; it is not a separate judgement about the scale.

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
| `speed` | Artificial Analysis output speed | Artificial Analysis serving stack | 40 tokens/s | 310 tokens/s | 2026-09-06 |
| `quotaCost` | blended public list price `(input + output) / 2` | vendor API | $2.50 / 1M tokens | $30.00 / 1M tokens | 2026-09-06 |

For `quotaCost`, the arithmetic is applied in the price direction: the cheap anchor is band 1 and the dear anchor is band 10. Scoring still inverts that band. The floor is a round stable list-price anchor near the cheapest cited list price ($2.63 for GPT-5.4 Mini), not Gemini Flash's temporary $2.25 promotional blend. A promotion applies to that model's figure only while the cited promotion is in force; it does not move the anchor or force unrelated rows to re-band.

Worked SWE-bench Verified example, under 60 → 1 and 96 → 10:

| Model | Figure | Band |
|---|---:|---:|
| Claude Opus 5 | 96.0 | 10 |
| Claude Fable 5 | 95.0 | 10 |
| Kimi K3 | 93.4 | 9 |
| Claude Sonnet 5 | 85.2 | 7 |
| Gemini 3.1 Pro | 80.6 | 6 |
| GLM 5.2 | 78.7 | 6 |

Every base row names the anchor pair in `evidence.text` and keeps its source figure in `evidence.sources`. Rows without a published figure are assessed anew against measured neighbours on the 1–10 scale, with the chosen rating in `evidence.hypothesis`; no old 1–5 value or mechanical `× 2 − 1` translation survives.

### Effort ladders and roles

From the base row, signed `steps` in the driver's effort order give:

```text
quality   = clamp(base.quality + steps, 1, 10)
speed     = base.speed
quotaCost = clamp(base.quotaCost + steps, 1, 10)
```

Keeping one `speed` band on every rung says exactly what is measured: throughput belongs to the model and serving stack. The extra output-token effect of deeper reasoning is represented only by the one-band `quotaCost` step, which moves `1 / 9` of the scale — under half of ADR-004's `1 / 4` on purpose (decision 3a): a two-band step preserved the old relative movement and drove long ladders into the clamp, where a top-tier model's low rung shared a band with the cheapest model in the catalog. Every rung remains in the catalog even when clamping makes two rungs indistinguishable. `models validate` warns with `ladder-indistinguishable` when two rows of one harness/model have the same three ratings and roles; it does not collapse them because the effort remains a launchable choice.

The default role floors become `qualityFloor.worker = 5` and `qualityFloor.reviewer = 9`. `reviewerQualityFloor` remains an alias for the latter. Worker roles are recomputed from the tuple rating. Reviewer eligibility is stricter: an interpolated rung is offered as `reviewer` only if its **base row's** assessed `quality` is at least 9. Upward interpolation never confers the role. The rule lives in catalog generation and validation; the resolver continues to trust the roles on a validated row.

### Scoring and document versions

All strategy weights are unchanged. Their rating components become:

```text
qualityComponent   = weight.quality × (quality - 1) / 9
speedComponent     = weight.speed × (speed - 1) / 9
quotaCostComponent = weight.quotaCost × (10 - quotaCost) / 9
```

The components still sum to the base score. The `balance` strategy's spend adjustment becomes:

```text
spendPenalty = balance.spendUnit × (quotaCost - 1) / 9
```

Catalog and overlay `schemaVersion` both become **2**. A catalog on any other version is refused. A v1 overlay carrying any value **on the rating scale** is refused by load and by `models validate` with this route, which names the keys it found:

```text
rewrite `ratings` on the 1–10 scale and set `schemaVersion: 2`
```

Three keys are on that scale: `ratings`, `qualityFloor` and `reviewerQualityFloor`. The floors are there for the same reason as the ratings and it is the easier one to miss — `reviewerQualityFloor: 5` meant the top band of five under ADR-004 and reads as half way up ten here, so a file read unchanged would LOWER a person's reviewer floor from the new default of 9 to 5 without a word, which is the one direction a floor must never move by itself. A value written on a scale that has been replaced is indistinguishable from one written on the new scale, so the document version is the only thing that can tell them apart. One list holds the three names (`SCALED_OVERLAY_KEYS`), and the JSON Schema mirrors it.

A v1 overlay carrying none of them remains valid and is read unchanged: deny and allow lists, weights, penalties, bonuses, priority, `payg`, defaults, account data and the consumer's policy layer did not change shape, and nobody has to edit a file whose meaning did not move. The decision document stays at `schemaVersion` **2** because its shape does not change; only the values and arithmetic behind existing fields do.

### `models calibrate`

`promptobus models calibrate [--json] [--write] [--yes]` reads `telemetry.jsonl` beside the host's cache. It groups by `(harness, model, effort)`, never by `tuple`: explicit-flag lifts commonly have `tuple: null`. Before matching a catalog row it resolves the Claude aliases `fable`, `opus` and `sonnet` through the driver's own alias-to-id table. A missing effort remains `null`; it is not guessed from a default.

For each key it prints the number of runs and medians of `durationSec`, `turns`, and `reviewRounds` per accepted piece. A record is an accepted piece when it was not dismissed before `done` and has at least one result. Window evidence is the per-run delta `usedPercentAtEnd - usedPercentAtSpawn` for every window whose end exists, and one run contributes ONE number: the LARGEST of those deltas. The resolver scores a tuple on `100 - max(usedPercent)` over exactly that set of windows, so the window that bound the pick is the window whose movement a proposal may argue with; summing them would count an account's session and weekly windows twice for the same tokens. A record without windows contributes no delta. Negative deltas, which indicate a reset or incomparable window, are shown as unavailable and do not enter a median.

Every band it compares against is the **shipped catalog's**, never the merged stack's. If the merged bands were the base, a person's own override would become the starting band of the next comparison: `--write`, then `calibrate` again on the same records, and the rating steps once more — up to two bands a run — drifting toward whatever the measured ratio implies with nothing new measured in between. Running the command twice on one telemetry file must propose the same thing twice. An override the person already has is PRINTED beside the catalog band (`catalog 5, your overlay 6`) rather than standing in for it.

The evidence threshold is the constant **5 runs per key**. Below it the line is `insufficient data: N of 5` and proposes nothing. At or above it, the **eligible key** with the most runs is the pivot; a tie is settled by `(harness, model, effort)`. The pivot keeps its catalog bands. A one-band difference implies a factor of **1.25** in duration for `speed` and window delta for `quotaCost`: `1.25^(band difference)`. For another key, compare its observed median ratio to the pivot with that catalog-implied ratio. A surprise of at least 1.5× moves one band; at least 3× moves two; inverse ratios move in the other direction. One run of `calibrate` is capped at ±2 and clamps to 1…10. `speed` moves down when duration is unexpectedly higher; `quotaCost` moves up when the window delta is unexpectedly higher. With one eligible key the pivot is simply retained; with two, one is the pivot and the other still cannot jump to an extreme. A zero or missing denominator omits that rating and explains why, and so does a measured **zero**: `usedPercent` arrives as whole percent and `durationSec` as whole seconds, so a median of 0 says the runs were below what the measurement can resolve rather than that the value is nearly nothing, and reading it as a ratio would propose the largest possible drop from an absence of evidence.

A key the catalog does not rate is neither a pivot nor a proposal — there is no band to move — and its medians are still printed, because a person looking at an unrated model wants the numbers that would justify rating it.

A proposed overlay line contains `speed` and `quotaCost`, the current catalog bands beside it, and the medians, pivot and ratios behind both. Missing usable duration or window evidence omits that one rating and explains why. `quality` is indirect; accepted-piece and review-round counts are printed as a note and never become a proposed rating.

`--write` merges only the proposed `ratings` into the host layer whose id is `user`, at the path the host declares. Every other key and every unproposed rating in that file is preserved, and the merge is per tuple and per rating rather than a replacement of the block. It writes only the ratings that MOVED: every eligible key still prints both ratings with its catalog band beside them, but a written value equal to the catalog would leave an override that says nothing and goes on saying it after the next catalog update moves the row underneath it. A `user` overlay on version 1 is raised to `schemaVersion` 2 together with the block, since a version 1 overlay carrying `ratings` no longer loads. An interactive terminal asks for explicit confirmation. Without a TTY the command refuses unless `--yes` is also present. `--yes` is valid only with `--write` and is refused on its own — it records agreement to a write, and without one there is nothing to agree to, so ignoring it would let a script that lost its `--write` read as having applied something. Under `--json` the write outcome is a field of the one document on stdout, and every refusal happens before that document is printed: a complete report beside a non-zero exit says two different things. The command never touches the shipped catalog or another layer.

This is the one exception to ADR-004's account-scoped user layer being read-only for the tool. It is narrow: only `models calibrate --write`, only `ratings`, only after confirmation.

### What this supersedes

Everything outside this table stands as accepted in ADR-003 and ADR-004.

| Decision and section | Superseded text | ADR-005 rule |
|---|---|---|
| ADR-003 § Strategies | `(r − 1) / 4 × 100`; quota cost `(5 − r) / 4 × 100` | `(r − 1) / 9 × 100`; quota cost `(10 − r) / 9 × 100` |
| ADR-003 § Catalog | 1–5 ratings | 1–10 integer ratings |
| § Quality floors per role | Defaults 3 and 5 on 1–5 | Defaults 5 and 9 on 1–10; alias retained |
| § Host contract | “`user` stays under the user home and is read-only for the tool” | `models calibrate --write` may merge only agreed `ratings` into that layer |
| § Catalog ratings from published results | Five relative rank bands over a field | Ten absolute bands from dated benchmark/version/harness anchors; there is no field |
| § Catalog ratings from published results | A hypothesis is kept out of the catalog | A row with no assessment is omitted; an assessed rating without a published figure is retained and marked as a hypothesis |
| § Catalog ratings from published results | `speed` and `quotaCost` move one band per effort step; `quality` one per two | `speed` is constant; `quality` and `quotaCost` each move one band per step on 1–10 |
| § Catalog ratings from published results | Clamp 1…5 | Clamp 1…10, keep every rung, warn when rungs are indistinguishable |

### Terms this decision adds

Proposed for [the glossary](../GLOSSARY.md); the documentation pass adds them there rather than leaving private vocabulary in this ADR.

| Term | Definition |
|---|---|
| anchor pair | The dated floor and ceiling for one benchmark version and agent harness; they map to bands 1 and 10. |
| band | One integer rating from 1 through 10 produced from a figure and its anchor pair. |
| local anchor | The eligible catalog key with the most telemetry runs; calibration keeps its catalog band while comparing other keys with it. |
| eligible key | A `(harness, model, effort)` telemetry key with at least five runs. |
| accepted piece | A telemetry record with a result that was not dismissed before `done`; only these enter completion medians. |

## Not in v1

- Automatic application of a proposal without `--write`, explicit agreement and confirmation.
- Writing calibrated ratings into the shipped catalog or any non-user layer.
- A telemetry-derived `quality` rating.
- Uploading telemetry or proposals.
- Telemetry fields beyond PB-36's record.
- Codex service tier as a tuple dimension, the driver's proven Claude version, Cursor pool mapping and reviewer diff snapshots; their existing tasks remain separate.

## Consequences

- A catalog rating is stable under field membership and sharper at the top. Its anchors are maintainer judgements that can become stale, so every catalog update is also an anchor review.
- Every rating override written on 1–5 must be rewritten. Policy-only v1 overlays keep working, which avoids forcing consumers to edit files whose meaning did not change.
- Resolver weights preserve their relative importance; only the rating resolution changes. Golden decisions move because a rating's numeric representation moves.
- Effort no longer pretends to change output throughput, and a ladder now spans as many `quotaCost` bands as it has rungs rather than twice that, so both of its ends stay comparable with other models instead of piling into 1 and 10. Clamped duplicate rungs remain visible and warn, so launchable effort choices are not erased merely because the coarse rating cannot distinguish them.
- Reviewer eligibility can no longer be created by interpolation. This deliberately removes reviewer from `codex-gpt55-xhigh` unless its base assessment itself reaches 9.
- Local telemetry can challenge the catalog without silently becoming truth. Relative local anchors are sensitive to which keys have five runs, but they are printed beside every proposal and affect only a confirmed user overlay.
- A dismissed run still accounts for subscription spend and never masquerades as an accepted piece; missing windows reduce quota evidence without erasing a completed run.
