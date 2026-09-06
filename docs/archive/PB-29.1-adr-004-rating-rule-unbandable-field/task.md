# PB-29.1 · ADR-004's rank-band rule cannot be applied to the published field: benchmark version, agent harness, and no workable field size

- **Scope:** [adr-004](../../adr/adr-004-subscription-balance.md) § Catalog ratings from published results, [guides/model-routing.md](../../guides/model-routing.md)
- **Created:** 2026-09-06
- **Dependencies:** PB-29 (found there; the catalog it produced is banded under the narrowing this file records)
- **Taken:** 2026-09-06

## Context

ADR-004 says, of `quality`:

> **The primary figure.** For each model, take the first of these that publishes a figure for **that exact model**: SWE-bench Verified, Terminal-bench, Aider polyglot, the vendor's own model card. **The band.** Sort the field — every model the catalog rates, plus every model the three harnesses expose that has a figure — by that figure, and cut it into five equal **ranks**.

PB-29 was the first pass to actually apply it, over the fifteen base models the three harnesses expose on 2026-09-06. The rule does not survive contact with the field, in four separate ways. Every figure below was read off a page opened during that pass; the URLs and dates are in the `evidence` of the rows they justify in `models/catalog.json`.

**1. A benchmark version is a different benchmark, and the ADR names none.** Terminal-Bench 2.0, 2.1, 3.0 and 4.0 are all in circulation and the sources say outright that they are not comparable. Grok 4.6 scores **88.4 on v2.1 and 26 on v3.0** — the same model, the same week. Sorting GPT-5.5's 82.7 (v2.0) against Gemini 3.8 Flash's 90.8 (v2.1) bands two models by which version their vendor happened to run.

**2. An agent harness is a different benchmark too, and the ADR does not mention harnesses at all.** Terminal-Bench scores *the model and its agent harness together*, and its own leaderboard says so. Measured, one version, one leaderboard:

| Model | Agent harness | Terminal-Bench 2.1 |
|---|---|---|
| Claude Fable 5 | Claude Code | 83.8 |
| Claude Fable 5 | Terminus 2 | 80.4 |
| GPT-5.5 | Codex CLI | 83.1 |
| GPT-5.5 | Terminus 2 | 78.0 |

And across leaderboards it is worse: **Gemini 3.8 Flash is reported at 90.8 and at 19.1 ± 3.4** on the same benchmark and version, the second under a mini-SWE-agent harness. Seventy points. A figure without its harness is not a figure, and a rule that bands on one is banding on noise.

**3. There is no field size at which a rank band both discriminates and holds still.** This is the deep one, and it is not fixed by naming a version or a harness.

- **Wide field.** The one SWE-bench Verified leaderboard opened for PB-29 ranks 65 models. `claude-sonnet-5` sits 7th on it — inside the top fifth — so it bands **5** and clears the ADR-004 reviewer floor, alongside `claude-opus-5` and `claude-fable-5`. The tail of a public leaderboard is full of models nobody here can launch, so every frontier model collapses into one band and the rating stops discriminating exactly where it is used.
- **Narrow field.** Band over the six models the catalog rates that have a Verified figure and `claude-opus-5` (96.0) and `claude-fable-5` (95.0) land in different bands **one point apart**, while the ADR's own tie rule cannot help because 96.0 ≠ 95.0.
- **And it is unstable under field membership.** Adding two models the Claude binary exposes but the catalog does not rate — `claude-mythos-5` at 93.9 and `claude-opus-4-8` at 88.6 — moves `claude-sonnet-5` from band 3 to band 2 without one fact about Sonnet changing. Dropping `glm-5.2` from the same field moves `claude-fable-5` from 5 to 4, which is the difference between a reviewer-eligible row and a worker-only one.

The ADR argued against equal-width bands because "one outlier compress[es] everything else into a single band" and "a narrow field would be spread across all five as if the differences were large". Both failures are true of rank bands as well, from the other side: the wide field compresses, the narrow field spreads. The choice between the two rules is not the choice the ADR thought it was making.

**4. The field the ADR defines is not reproducible.** "Every model the three harnesses expose that has a figure" is unbounded in practice — Cursor alone lists about 210 ids — and it is the half of the definition that item 3 shows carries the most leverage. PB-29 took only the first half, the models the catalog rates, because that set is recomputable from the catalog file itself, which is what makes a band auditable at all.

**The cut PB-29 used, written out because the ADR does not write it.** "Cut it into five equal ranks" has more than one arithmetic reading, and they disagree about real rows. Sorting the sub-field best first, with 1-based position `pos` and field size `n`:

```text
band = 5 - floor((pos - 1) * 5 / n)
```

The other natural reading, `band = 6 - ceil(pos * 5 / n)`, puts `claude-fable-5` in band 4 instead of 5 on a six-model field — which takes it out of the reviewer role. A rule whose bands depend on which of two obvious formulas a maintainer picks is not reproducible, and PB-29.1 promises that the bands reproduce row for row. Whichever rule replaces this one must state its arithmetic in the ADR, not leave it to the reader.

**What PB-29 shipped under this finding.** Band by rank with the formula above, only inside a sub-field that is one benchmark at one version, over rated models only, and only where that sub-field holds at least five of them; record the benchmark, the version, the agent harness where the page names one, the figure, the field size, the URL, the date and whether the page is primary or secondary in the row's `evidence`; where a model has several figures for one benchmark and version, prefer the one measured on the harness this catalog runs it on, else the highest published, and say which rule applied; and where no sub-field qualifies, the rating is a stated hypothesis with its reasoning rather than an invented number. Under that narrowing, exactly one sub-field qualified — SWE-bench Verified, six rated models — and **nine of the fifteen base models carry a hypothesis for `quality`**, including every Codex row.

## Work to do

- Replace the rank-band rule in ADR-004 § Catalog ratings from published results. The proposal, measured against this field rather than invented: **absolute bands per benchmark and version, fixed in the ADR and revisited at each catalog update** — for example SWE-bench Verified ≥ 90 → 5, ≥ 85 → 4, ≥ 80 → 3, ≥ 70 → 2, below → 1, with its own table per benchmark and version.
- Name the **agent harness** as part of a figure's identity wherever the ADR names a benchmark, and make "the harness this catalog runs the model on" the tie rule rather than a convention PB-29 invented in passing.
- Decide the field definition explicitly: rated models only (reproducible from the catalog file) or the wider set (not reproducible), and say which, rather than leaving a reader to discover that the sentence admits both.
- Carry the outcome into [guides/model-routing.md](../../guides/model-routing.md), which tells a maintainer how to re-rate a row.
- **Fix a wording defect in the same section.** ADR-004 says of a rating with no published figure that it "stays a hypothesis, which ADR-003 already keeps out of the catalog" — and the catalog PB-29 shipped keeps nine such rows, deliberately and on the owner's instruction. The two sentences describe different rules. The one that is right is the one the owner gave: a hypothesis is a row **marked** as such, not a row **omitted**, because dropping it would silently remove a model the person can launch on the grounds that a leaderboard has not got round to it. ADR-003's sentence is about a rating with no *assessment* at all, which is a different thing from an assessment with no *published number*, and the ADR should say which of the two it means wherever it says "hypothesis". The guide's copy of the sentence was fixed in PB-29; the ADR's is this pass's.

**The cost of absolute bands, named rather than discovered.** They are numbers nobody published, which is precisely the objection ADR-004 raised against them — "invented numbers in an ADR". They go stale as the field moves, and silently, which is the failure ADR-003 named for a stale rating. What they buy is the two properties a rank band cannot have at once: a rating that does not move because a neighbouring row was added or removed, and a rating that still separates the top of the field. The staleness is answerable — a threshold table dated in the ADR and revisited when the catalog is, which is already an event-driven pass — while the instability is not answerable at all. That is the trade, and it is the owner's to take.

**A second defect of the same section, found in the same pass.** The interpolation clamp flattens whole ladders. `gemini-3.7-flash` produces three rows with identical ratings (1/5/1) because its base row already sits at the clamp on `speed` and on `quotaCost` and the quality step is one band per two levels; `gpt-5.6-sol` is `quotaCost` 5 at medium, high, xhigh, max and ultra alike. The ADR states the flattening as intended — "a long ladder flattens at its ends" — but a three-rung ladder is not a long one, and three rows that differ only in the id are three rows the resolver will tie-break on the id. Worth deciding whether a ladder whose rungs are indistinguishable should collapse to one row.

**A fourth, surfaced by the review fix and arguably the worst of them: `speed` is banded over one quantity and interpolated as if it were another.** The band comes from published **output throughput** in tokens per second, which is a property of the model and the serving stack and barely moves with reasoning effort. The interpolation then changes it one band per step, which is the behaviour of **latency to an answer** — a different quantity, which moves with effort because effort changes how many tokens get generated, not how fast each one is. The two were the same number as long as base rows sat in the middle of their ladders. Once `gpt-5.6-sol` was rebased on `max`, where its 90 tokens/s was actually measured, three steps down to `medium` clamp its `speed` to 5 — rating a frontier reasoning model at medium effort as fast as `gemini-3.7-flash`, which genuinely serves 305 tokens/s. Nothing about sol's throughput changes with effort; only the number of tokens it spends does. Either the band should be cut over a latency-shaped figure (time to a finished answer on a fixed task), or `speed` should not be interpolated along the effort ladder at all and should instead carry the token-count effect in `quotaCost`, where it already lives. This is the row of the interpolation table most likely to be wrong in kind rather than in degree.

**A third, smaller.** Interpolation can carry a row *up* to the reviewer floor: `codex-gpt55-xhigh` reaches `quality` 5 from a base row of 4 across two steps, and is offered as a reviewer on arithmetic rather than on a measured figure. (`codex-terra-ultra` looked like a second case in the first cut of PB-29 and was not: its ladder had been based on `medium` when the source states the figure was measured at `max`, and once the base row moved to where ADR-004 § 250 puts it, the row bands 3 and takes no role. That is one point in favour of the base-row rule as written, and a reminder that a wrong base row is invisible in the ratings it produces.) That may be right — it is what the rule says — but it is not what "the reviewer is the last reader" argues for, and the owner should say so on purpose.

## Out of scope

- Re-rating `models/catalog.json`. PB-29 shipped it under the narrowing above; this file changes the rule, and the catalog is re-banded in the pass that lands the change.
- Automatic ratings from telemetry. Still ADR-003 "Not in v1", and the `cursor-grok-4.6` row shows why it is tempting: the owner's own `GetAggregatedUsageEvents` reading is the strongest `quotaCost` evidence in the whole catalog and is still only a hypothesis.

## Verification

- ADR-004 § Catalog ratings from published results names a benchmark, a version and an agent harness wherever it names a figure, and states one field definition.
- The bands it fixes reproduce, row for row, the `quality` of every rated row in `models/catalog.json`, or the catalog moves with it in the same pass.
- `npx github:Velklish/backslop#v0.4.0 lint`, `npm test`, `npm run audit`, `promptobus models validate` green.

## Deferred

- **Deferred:** 2026-09-06
- **Reason:** the rating rule's defects (mixed benchmarks and versions, the agent-harness axis, the field-size trap, the throughput-vs-latency interpolation of `speed`, the `hypothesis` wording) are fixed in the ADR pass of the next series (PB-37: 1–10 scale, absolute bands per benchmark and version, `models calibrate`), not by editing an accepted ADR mid-run; the 0.4.0 catalog ships as the rule produces it, with every band's basis in `evidence`.
- **Return condition:** the `v0.4.0` tag is cut; this returns to the queue beside PB-37 as its input.
