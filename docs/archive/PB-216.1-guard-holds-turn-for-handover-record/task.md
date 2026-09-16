# PB-216.1 · The loop guard holds the turn for a gate record without result, but not for a handover record

- **Order:** 400
- **Scope:** `lib/guard.js` (the gate-record hold), [04-protocol](../../reference/04-protocol.md) § The handover record
- **Created:** 2026-09-16
- **Dependencies:** none
- **Parent:** PB-216

## Context

`PB-216` made the handover record the worker's pre-handover evidence: five checks, one file,
attached before `result`. The loop guard already holds a turn that ends after a gate record
was sent and no `result` followed — the record is a promise of a report. The handover record
got no such rule: a worker can end its turn after `handover-*.json` and before `result`, the
guard lets it go, and the reviewer is lifted on half a handover. The track that closed
`PB-216` did not own `lib/guard.js` (another track edited it in the same run), so the rule
was recorded here rather than written there.

> Source: 2026-09-16, `PB-216` result.md, open item 1; `lib/guard.js` on `main` at
> `77b382f`.

## Work to do

- The same hold for a handover record without a following `result`, with the same message
  shape as the gate-record hold; the test sits next to the gate-record hold test.

## Out of scope

- What the record contains — `PB-216`.
- Holding the turn for other artifact types.

## Verification

- Guard test: handover record sent, no `result`, turn ends → held, and the line names the
  record file. Mutation probe: remove the new clause → that test reddens and the gate-record
  test does not.
