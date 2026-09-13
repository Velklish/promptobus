# PB-205 · Telemetry has the role but not the turns, the spend or the idle time

- **Order:** 60
- **Scope:** `lib/model-routing/telemetry.js` (record projection, `telemetryStats`), `lib/done.js` (what is computed before the journal can be pruned), `docs/reference/03-cli.md` § Participant telemetry
- **Created:** 2026-09-12, from an attempt to price a run by role
- **Dependencies:** PB-202

## Context

A participant telemetry record already exists ([PB-36](../PB-36-participant-telemetry-record/result.md)): `done` appends one JSON line per participant that lifted a session, with the tuple, the strategy that chose it, the lift and end stamps, the bus traffic, the quota windows and `concurrentParticipants`. It carries `role`, and it lives outside the bus journal, so it survives pruning.

Three of the four numbers needed to price a run by role are not in it.

**Turns.** The field named `turns` counts messages the participant sent, not turns of the model. Measured on the same participants: a Claude worker takes a median of 167 model requests per session, and its bus traffic is an order of magnitude smaller. Anyone reading `turns` as effort reads the wrong quantity.

**Spend.** There is no money field at all, and the token fields are empty for every harness but one — that is PB-57.1, corrected by PB-202: the numbers exist on disk for Codex and Claude, and nowhere for Cursor. For an attached session — the orchestrator — they do not exist in any form.

**Idle.** Not recorded anywhere. The sources exist while the journal lives: `health.json` (`deliveredAt`, `knockedAt`, `since`, `knocks`), `supervisor.log`, `waits/<addr>.turn.json`, and the timestamps of the canonical messages. None of it is projected into the record, and `prune` removes the task directory whole — after that the idle time of that run is unrecoverable.

What it is worth knowing: 492 blocking waits across the runs, 114 hours of participant time, p50 2.7 min, p90 27.2 min, maximum 417 min.

> Source: 2026-09-12, `block.py` and `latency.py` in the session scratchpad over `<workspace>/.promptobus/tasks/*/messages/*.json`; turn counts from participant transcripts (`turns.py`).

## Work to do

- State what a per-role summary must answer, before adding any field: how much of a run each role costs, where the wall-clock goes, and which role is the bottleneck.
- Compute at close what dies with the journal — idle and delivery latency are derivable only while `health.json` and `messages/` exist. Either project them into the record at `done`, or accept losing them and say so.
- Rename or re-document the `turns` field so that it cannot be read as model effort; if model turns are wanted, name their source per harness (PB-202).
- Additive fields only — the projection is deliberately field-by-field, and the privacy criterion of PB-36 stands: no prompt text, no bodies, no paths, no session ids.

## Out of scope

- Calibration and the scale — [ADR-005](../../adr/adr-005-ten-point-scale-absolute-bands-calibrate.md); `calibrate` groups by `(harness, model, effort)` and does not read the role.
- Pricing an attached session — refused by measurement in PB-202; the summary must not promise it.
- Retention of the journal — decided at 14 days by the consumer's own card.

## Checks

- On a closed run the summary answers the three questions above per role, and every number in it names the field it came from.
- A run whose journal has been pruned still yields the same summary — that is the test that the projection happened at close, not at read.
- Privacy: a grep over the appended records finds no path, no body, no session id; the check that PB-36 used stays green.
- The `turns` ambiguity is closed by a fixture: a participant with few messages and many model turns shows both numbers distinctly, or the record says it does not have the second one.
