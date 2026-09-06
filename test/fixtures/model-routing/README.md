# Model-routing golden fixtures

Six **golden** files: one pair of inputs with one pair of outputs, and a second pair of inputs with no golden output of its own. The other files in this directory are not golden: they are the **adapter fixtures** — redacted copies of the harness answers the spike of 2026-09-06 measured, named `claude-*` and `cursor-*`, read by `test/model-routing-adapter-{claude,cursor}.test.mjs` and by nothing else. A secret in one of them is written `<redacted>`, which is also what `npm run audit` scans the tree for.

The golden set:

| File | What it is |
|---|---|
| `catalog.json` | the merged catalog the run sees. Placeholder harnesses and models; the ratings are not claims about any real model |
| `snapshot.json` | the availability cache the run reads. Version 2 since ADR-004: `example` carries a tier and two windows — an account-wide session one and a weekly one scoped to a model family — and `other` carries a `null` tier and no window at all, which is the harness the `unknown-remaining` warning is about |
| `decision.json` | the golden `models --json` output |
| `models.txt` | the golden `models` text output |
| `balance-catalog.json` | the catalog of the **balance** pair: six tuples over the three real harness names, two of them on one Cursor model family and one on a model the account hides |
| `balance-snapshot.json` | the availability cache of that pair. Three harnesses with real windows — Claude with a session, a weekly and a weekly scoped to a model family; Codex with a session and a weekly; Cursor with two pool windows in one monthly billing cycle — plus a hidden rated row and a hidden unrated one on Codex |

A golden output with no pinned input cannot be reproduced by the task that has to make it green, which is why the inputs are here too.

## The balance pair has no golden output, and that is deliberate

The golden pair above is one harness with a window and one with none, which cannot show a pace comparison at all: `balance` compares harnesses, and one paced harness is not a comparison. The balance pair exists to be that comparison, and `test/model-routing-resolver.test.mjs` drives it directly rather than through a third golden file — a golden pins a whole document, and what needs pinning here is a dozen numbers that each mean something on their own.

Where its numbers come from, on the same frozen clock (`2026-09-05T09:00:12.000Z`):

| Harness | Binding window for | `usedPercent` | `elapsedShare` | `underspend` |
|---|---|---|---|---|
| claude | `claude-opus-5` → the account-wide weekly | 30 | 40.48 % | **+10.48** |
| claude | `claude-fable-5` → the weekly scoped to that family, which is the more spent of the two that apply | 38 | 40.48 % | **+2.48** |
| codex | both tuples → the weekly, more spent than the session | 46 | 62.50 % | **+16.50** |
| cursor | `composer-2.5` → the `auto` pool, which names it | 62 | 47.92 % | **−14.08** |
| cursor | `gpt-5.6-via-cursor` → the `api` pool, the complement: every model in no `auto` list falls there | 72 | 47.92 % | **−24.08** |

With the default `spendUnit` of 5 the penalties are `5 × (quotaCost − 1) / 4`, so the effective numbers are +5.48, −0.02, +12.75, −15.33 and −29.08. Codex leads by more than the band of 5, and it is chosen.

**The point of the pair is that the two strategies disagree on one snapshot.** `balanced` picks `claude-fable` at 68.05 — the best-rated tuple. `balance` picks `codex-sol` at 65.60, because Cursor's auto pool is fourteen points ahead of its own cycle while Codex is sixteen behind its week. That is the behaviour ADR-004 exists for, and a fixture on which both strategies agreed would not show it.

## The run these outputs come from

```text
promptobus models --strategy balanced --role worker            → models.txt
promptobus models --strategy balanced --role worker --json     → decision.json
```

with `catalog.json` as the catalog, `snapshot.json` as the cache, **no overlay file present at either layer**, no live participant on any harness, no explicit `--harness`, `--model` or `--effort`, and `--allow-payg` absent. The clock is frozen at `2026-09-05T09:00:12.000Z` — twelve seconds after the snapshot's `takenAt`, which is where `ageSec: 12` comes from.

## Comparison is byte-for-byte after two normalisations

**The availability block.** `decision.json` carries `harnesses`: the snapshot projected onto the decision, one row per harness with its tier and every window. It is assembled by the COMMAND, not by the resolver, which reads no disk; the resolver check composes it with the same exported `availabilityOf` the command uses rather than a copy, so the two runs cannot disagree about it. It is **not** normalised, because it holds no path and no clock the run produces — it is compared exactly, like everything else below the two fields that cannot be.

Two kinds of field cannot be compared raw, and both are normalised before the diff rather than excluded from it — an excluded field is an unpinned field.

1. **Paths.** The overlay paths in `decision.json` are written as `~/.promptobus/model-routing.json` and `<workspaceRoot>/.promptobus/model-routing.json`. The comparison replaces the home directory with `~` and the workspace root with `<workspaceRoot>`, longest prefix first, then compares. The placeholders stay in the fixture: a fixture holding one machine's home directory is a fixture only that machine can read.

   Two checks do that replacement, and the paths they replace differ because what they run differs. The command check (`test/model-routing.test.mjs`, pending until the `models` command exists) runs the real command and substitutes the run's real `os.homedir()` and workspace root — that is the end-to-end claim, and only the real paths test it. The resolver check (`test/model-routing-resolver.test.mjs`) calls a pure function and hands it synthetic paths no machine has, then substitutes those: with the host mocked out there is no real home in the document to find, and driving the substitution with paths the machine does not own is what keeps the check from passing by accident on a machine whose home happens to be absent from the output.
2. **Clock.** `takenAt` and every `checkedAt` come from `snapshot.json` and travel through the run unchanged, so they compare as they are. `ageSec` is the only value the clock produces, and the run that reproduces these files freezes the clock at the timestamp above.

Nothing else is normalised. Scores, order, exclusion reasons, warnings, the runtime rows and every character of `models.txt` are compared exactly.

## Where the numbers come from

`balanced` weights are 40 / 25 / 20 / 15. A rating `r` on the 1–5 scale normalises as `(r − 1) / 4 × 100`, and `quotaCost` inverted as `(5 − r) / 4 × 100`. `remaining` is `100 − max(usedPercent)` over the **applicable** windows of each tuple — the account-wide ones plus the scope covering it (ADR-004) — and 50 when none apply, plus the −10 `unknown-availability` adjustment. `example`'s largest applicable window is the session one at 40 for both of its tuples, so `remaining` is 60 for both: the model-scoped weekly window applies to `example-deep-high` and sits below the session window at 12, so it binds nothing and moves no score. It is here to pin the SHAPE of a scope, and the balance pair above is where a scope actually changes an answer. That gives `example-quick` 69, `other-steady` 66.25 − 10 = 56.25, `example-deep-high` 55.25. The rules are [ADR-003](../../../docs/adr/adr-003-model-routing.md); `model-routing.test.mjs` checks the fixture against them rather than trusting the arithmetic.
