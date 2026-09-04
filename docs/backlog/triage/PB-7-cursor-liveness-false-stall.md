# PB-7 · Cursor liveness check declares a stall while the session is editing files

- **Scope:** [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-05
- **Dependencies:** none

## Context

Reported by the first consumer from a live run on 2026-09-04 (and again on 2026-09-05). The warden twice announced a Cursor participant stalled — “the turn transcript has been silent for more than 180 s” — while the session was actively editing files and committing; the owner opened the panel and saw “16 files edited”, the participant replied that the turn was alive and named a commit from the same window. The liveness signal (transcript growth) does not cover a long tool-execution or reasoning phase, and no indirect proxy the orchestrator tried (file mtimes, test processes) was reliable either.

## Work to do

- Find a liveness signal that covers a turn without transcript growth (Cursor's own session state, the process tree of the turn, the last tool event), or widen the stall criterion for the Cursor driver with the reason named in the report.
- The stall report must say what was measured and for how long, so an orchestrator can tell “silent transcript” from “dead session”.

## Out of scope

- Nothing named yet.

## Verification

- Driver contract suite: a turn that writes files without transcript growth is not a stall; a truly dead session still is.
