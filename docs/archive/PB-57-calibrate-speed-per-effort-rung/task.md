# PB-57 · `models calibrate` groups by effort and proposes a per-rung `speed`, so `--write` leaves one model's rungs disagreeing on a rating ADR-005 defines as constant along the ladder

- **Scope:** `lib/model-routing/calibrate.js`, `lib/model-routing/validate.js`, `models/catalog.json`, [adr-005](../../adr/adr-005-ten-point-scale-absolute-bands-calibrate.md), [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** PB-77, PB-37.2
- **Taken:** 2026-09-09

## Context

`lib/model-routing/calibrate.js:250` — `const id = JSON.stringify([r.harness, model, effort]);` — puts `effort` in the grouping key, and line 328 (`speed: proposeRating({ observed: k.durationSec, pivotObserved: pivot.durationSec, band: k.catalog.speed, pivotBand: pivot.catalog.speed, direction: -1, … })`) proposes one `speed` band per that key, driven by wall-clock `durationSec`.

The shipped `models/catalog.json` rates all four `claude-opus-5` rungs (`high`, `xhigh`, `max`, `medium` — lines 64, 203, 317, 345) at `speed: 2`, so the catalog's own `implied` ratio for a deeper rung is always 1 while measured duration only grows with effort — a bias that is systematic, not sample noise.

Reproduced now with a probe (six records of `claude/claude-opus-5/high` at 500s, six of `/xhigh` at 1400s, `calibrate()` called directly against the shipped catalog): `high` is the pivot and keeps `speed: 2`; `xhigh` is proposed `speed: 1` (`ratio: 2.8`, `implied: 1`, `move: -1`). A `--write` on this input would leave the merged stack reading `speed 2` on `high` and `speed 1` on `xhigh` for one model.

ADR-005 rejects exactly this in its own decision 4 (line 15): "Interpolating `speed` along an effort ladder mixed throughput with time to a completed answer"; § Effort ladders and roles (line 125) fixes `speed = base.speed`; and its supersession table (line 189) restates "`speed` is constant" as the rule superseding ADR-004's per-step movement. The same document's § `models calibrate` (line 161) documents the `(harness, model, effort)` grouping key without reconciling it with decision 4 — the two halves of ADR-005 contradict each other on this point.

No guard catches the result: `validate.js` names `speed` only in `RATING_KEYS`/`WEIGHT_KEYS` (lines 38-39); `ladderChecks` (lines 867-889, run on the MERGED tuples at line 984) warns only when two rungs coincide on every rating and role — never when they disagree on `speed` alone. `node --test test/model-routing-calibrate.test.mjs` passes 35/35; its one cross-key case (lines 206-209) compares `claude-sonnet-5/xhigh` against an **opus** pivot — two different models — so two rungs of one model are untested.

## Work to do

- Propose `speed` per `(harness, model)` instead of per `(harness, model, effort)`: pool the accepted pieces of every rung of one model into a single duration median and write the resulting proposal to every tuple of that model. `quotaCost` stays per `(harness, model, effort)` — the catalog ladder already carries the effort step there
- Keep the printed report per key (a reader still wants each rung's own medians) but state in `docs/reference/03-cli.md` § `models calibrate` that a ladder gets one `speed` line
- Add a regression case to `test/model-routing-calibrate.test.mjs` covering two rungs of one model
- Alternative, if per-rung `speed` is wanted after all: amend ADR-005 to say a calibrated `speed` measures time-to-completion rather than the catalog's throughput, and add a `models validate` check that a model's rungs agree on `speed` so the two meanings cannot silently mix in one merged stack — an owner decision, not a default

## Out of scope

- Any change to `quotaCost`'s per-effort proposal — only `speed` grouping is affected
- Re-litigating the anchor-pair or benchmark evidence behind ADR-005 — this is about the grouping key `calibrate` uses, not the catalog's published figures

## Verification

- The new regression case above
- The probe described in Context (six runs at each of two effort rungs of one model): after the fix, both rungs receive the same `speed` proposal
- `npm test`

## Triage — 2026-09-07

- **Track:** T — Telemetry and calibration.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/model-routing/calibrate.js:250`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Design checkpoint before changing calibration speed. ADR-005 defines speed as throughput, while durationSec measures elapsed completion time including review and wait time. Pooling efforts does not make duration throughput. Establish a measured throughput input, or explicitly approve a different calibrated metric in a new decision; do not silently equate them. No rating writes during this checkpoint.
