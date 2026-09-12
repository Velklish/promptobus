# PB-187 · The catalog names a Codex model the binary does not have, and nothing compares the two lists

- **Order:** 200
- **Scope:** `models/catalog.json` (`codex-mini-*`), `lib/model-routing/validate.js` (`models validate`),
  [reference/03-cli](../../reference/03-cli.md) § models, [guides/model-routing](../../guides/model-routing.md)
- **Created:** 2026-09-12, release run
- **Dependencies:** none

## What happens

The catalog offers `codex-mini-medium` / `codex-mini-high` with `"model": "gpt-5.4-mini"`. The
installed binary does not know that name. Measured 2026-09-12 on codex-cli 0.146.0:

```
codex debug models → gpt-reserve, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna,
                     gpt-5.5, gpt-5.3-codex-spark, codex-auto-review
```

Seven names, and `gpt-5.4-mini` is not among them. Of the eighteen codex tuples in the catalog
this is the only one with no counterpart in `model/list`; the other four model names are all
present.

**The failure is cheap and loud, and that part is right.** A lift on the missing model is refused
**before the thread starts** — the message names the model, no journal is written, no turn is
billed. The cost is a wasted lift attempt and the time of whoever has to work out why.

**But nothing warns before the lift.** `models validate` sweeps references, weight sums and
contradictions inside the catalog; it never asks the binary what it can run. So a tuple can name
a model that has been renamed or withdrawn upstream and stay in the catalog indefinitely — with
its ratings, its `quotaCost: 1` and its place in the routing order, where `balance` can pick it.

**How it surfaced:** the orchestrator named `gpt-5.4-mini` to two workers in the same hour as the
cheapest Codex tuple in the catalog, because the catalog says so. One of them tried to lift it and
was refused; the other was stopped in time.

## Work to do

- Decide what should hold the comparison. Two shapes, and the choice is the package's:
  - **`models validate` asks the binary.** One local call per harness (the same call the measurement
    used), a tuple naming an unknown model becomes an error. Cost: validate stops being purely
    offline, which is a real change to what the command promises.
  - **The refusal teaches instead.** Keep validate offline, but make the lift's refusal say what the
    binary *does* know and which catalog tuples are affected, so the next person is not left with a
    bare name.
- Whichever is taken, say in the model-routing guide that catalog membership is not a promise that the binary
  can run the model, and where that is checked.
- Rate the affected tuples honestly in the meantime: a tuple that cannot lift should not be the
  cheapest option the resolver offers.

## Out of scope

- The Cursor and Claude halves: no mismatch was measured there, and this card does not claim one.
- Catalog ratings in general (`ADR-005` and the calibration flow).
- The refusal path itself, which behaved correctly: it cost nothing and named the model.

## Verification

- A catalog tuple naming a model the installed binary does not list is caught before a lift is
  attempted — or the refusal names the known set, and the reference says which of the two holds.
- The statement "the binary knows N models" in any result rests on `codex debug models` output, not
  on the catalog.
