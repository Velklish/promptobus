# Model-routing golden fixtures

Four files, and they are one pair of inputs and one pair of outputs:

| File | What it is |
|---|---|
| `catalog.json` | the merged catalog the run sees. Placeholder harnesses and models; the ratings are not claims about any real model |
| `snapshot.json` | the availability cache the run reads. Version 2 since ADR-004: `example` carries a tier and two windows — an account-wide session one and a weekly one scoped to a model family — and `other` carries a `null` tier and no window at all, which is the harness the `unknown-remaining` warning is about |
| `decision.json` | the golden `models --json` output |
| `models.txt` | the golden `models` text output |

A golden output with no pinned input cannot be reproduced by the task that has to make it green, which is why the inputs are here too.

## The run these outputs come from

```text
promptobus models --strategy balanced --role worker            → models.txt
promptobus models --strategy balanced --role worker --json     → decision.json
```

with `catalog.json` as the catalog, `snapshot.json` as the cache, **no overlay file present at either layer**, no live participant on any harness, no explicit `--harness`, `--model` or `--effort`, and `--allow-payg` absent. The clock is frozen at `2026-09-05T09:00:12.000Z` — twelve seconds after the snapshot's `takenAt`, which is where `ageSec: 12` comes from.

## Comparison is byte-for-byte after two normalisations

Two kinds of field cannot be compared raw, and both are normalised before the diff rather than excluded from it — an excluded field is an unpinned field.

1. **The availability block.** `decision.json` carries `harnesses` — the snapshot projected onto the decision, one row per harness with its tier and every window. It is assembled by the COMMAND, not by the resolver, which reads no disk; the resolver check composes it with the same exported `availabilityOf` the command uses rather than a copy, so the two runs cannot disagree about it. It is not normalised — it holds no path and no clock the run produces.

The two normalisations proper:

1. **Paths.** The overlay paths in `decision.json` are written as `~/.promptobus/model-routing.json` and `<workspaceRoot>/.promptobus/model-routing.json`. The comparison replaces the home directory with `~` and the workspace root with `<workspaceRoot>`, longest prefix first, then compares. The placeholders stay in the fixture: a fixture holding one machine's home directory is a fixture only that machine can read.

   Two checks do that replacement, and the paths they replace differ because what they run differs. The command check (`test/model-routing.test.mjs`, pending until the `models` command exists) runs the real command and substitutes the run's real `os.homedir()` and workspace root — that is the end-to-end claim, and only the real paths test it. The resolver check (`test/model-routing-resolver.test.mjs`) calls a pure function and hands it synthetic paths no machine has, then substitutes those: with the host mocked out there is no real home in the document to find, and driving the substitution with paths the machine does not own is what keeps the check from passing by accident on a machine whose home happens to be absent from the output.
2. **Clock.** `takenAt` and every `checkedAt` come from `snapshot.json` and travel through the run unchanged, so they compare as they are. `ageSec` is the only value the clock produces, and the run that reproduces these files freezes the clock at the timestamp above.

Nothing else is normalised. Scores, order, exclusion reasons, warnings, the runtime rows and every character of `models.txt` are compared exactly.

## Where the numbers come from

`balanced` weights are 40 / 25 / 20 / 15. A rating `r` on the 1–5 scale normalises as `(r − 1) / 4 × 100`, `quotaCost` inverted as `(5 − r) / 4 × 100`, and `remaining` is `100 − max(usedPercent)` over the harness's windows — 50 when there are none, plus the −10 `unknown-availability` adjustment. `example`'s largest is the session window at 40, so `remaining` is 60; the model-scoped weekly window sits below it at 12 and moves no score, which is deliberate — it exists here to pin the SHAPE of a scope, and reading it per tuple is the resolver's own task (PB-30). That gives `example-quick` 69, `other-steady` 66.25 − 10 = 56.25, `example-deep-high` 55.25. The rules are [ADR-003](../../../docs/adr/adr-003-model-routing.md); `model-routing.test.mjs` checks the fixture against them rather than trusting the arithmetic.
