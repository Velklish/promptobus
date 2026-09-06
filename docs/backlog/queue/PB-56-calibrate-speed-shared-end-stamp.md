# PB-56 · `calibrate` derives `speed` from `durationSec`, which for an accepted piece runs to the CLOSE of the task, not to the participant's own result — so every key of a run shares one end stamp

- **Order:** 280
- **Scope:** `lib/model-routing/calibrate.js`, `lib/model-routing/telemetry.js`, `schemas/model-routing/telemetry.schema.json`, `schemas/v1/message.schema.json`, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** PB-57

## Context

`lib/model-routing/calibrate.js:287` — `durationSec: median(accepted.map((r) => r.durationSec))` — feeds `proposeRating` for `speed` at lines 322-330. That number comes from `lib/model-routing/telemetry.js`'s `endOf(p, closedAt)` (lines 210-213): it returns the participant's dismissal timestamp when there is one, and otherwise `closedAt`, which is `recordedAt` — the moment `done` ran (`isoStamp(at)` at line 265, passed into `endOf` at line 275). For a record that is NOT dismissed, `endedAt` is therefore the close of the task, identical for every participant of it; `test/model-routing-telemetry.test.mjs:233-237` pins exactly that ("the duration runs from the lift to the close").

`acceptedPiece` (`lib/model-routing/calibrate.js:128-129`) admits only records with `dismissedBeforeDone !== true` — precisely the records whose end is the shared close.

Re-measured now on the live files: `/Users/kim.p/.agents/model-routing/telemetry.jsonl` holds 40 records — 38 dismissed (35 of them with a result), and exactly 2 accepted pieces, a worker/reviewer pair of one task sharing `endedAt === recordedAt === 2026-09-06T04:05:27.361Z`, `durationSec` 63 and 29 respectively, a ratio driven only by when each was lifted. `/Users/kim.p/.promptobus/model-routing/telemetry.jsonl` shows the mechanism directly within one task (`fd6caadb7b7e586b`): its worker (`durationSec` 750, an accepted piece) and its reviewer (`durationSec` 332, itself excluded from `acceptedPiece` because its `resultCount` is 0) share `endedAt === recordedAt === 2026-09-06T08:54:21.440Z` — the reviewer's real working time is invisible either way, because its recorded end is the task's close, not its own last message.

The comment at `calibrate.js:123-126` calls this duration "the time to a finished piece of work", which for a non-dismissed record it is not; `docs/reference/03-cli.md` documents the field's real meaning honestly elsewhere (the participant's dismissal, otherwise the close).

Every message carries a required `ts` (`schemas/v1/message.schema.json:8`), and `tallies()` (`lib/model-routing/telemetry.js:149-183`) already reads every message file and already branches on `type === 'result'` (line 177) — the participant's own last-result timestamp is one field away from being captured.

## Work to do

- Have `tallies()` also keep the `ts` of each sender's last `result` message
- Carry it on the telemetry record as an additive field (e.g. `lastResultAt`) in `schemas/model-routing/telemetry.schema.json`
- Compute `speed`'s duration to that stamp for a participant that sent a result, falling back to the dismissal, then to the close, as today
- Update the comment at `calibrate.js:123-126` and the field description in `docs/reference/03-cli.md` § Participant telemetry to state which stamp `speed` now measures
- Add a regression case to `test/model-routing-telemetry.test.mjs` / `test/model-routing-calibrate.test.mjs` covering a worker and reviewer of one task with different last-result stamps but the same close

## Out of scope

- Revisiting ADR-005 §4B's exclusion of dismissed runs from the completion medians — worth a look once a per-participant end exists, but a separate decision
- PB-37.2 (the window/spend half of the same telemetry gap) — this entry is the duration half only

## Verification

- The new regression case above
- `npm test`
- On the owner's live telemetry file, a re-run of `models calibrate` after the change shows the worker/reviewer pair of a shared task with two different `durationSec` values instead of one shared end stamp

## Triage — 2026-09-07

- **Track:** T — Telemetry and calibration.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/model-routing/calibrate.js:287`, `test/model-routing-telemetry.test.mjs:233`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** After PB-57 settles the metric, record the participant result timestamp with explicit worker/reviewer semantics and old-record fallback. A different end stamp alone does not make wall-clock duration a throughput measurement.
