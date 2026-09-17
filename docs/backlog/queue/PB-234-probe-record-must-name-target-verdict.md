# PB-234 · The probe record cannot tell "the intended verdict went red" from "something went red"

- **Order:** 380
- **Area:** `schemas/v1/handover-record.schema.json`, the send-time schema check
- **Created:** 2026-09-17, finding from a consumer's run
- **Dependencies:** none

## Measurement

The handover record already carries `mutationProbe.reddened` — the names that went red. What it does not carry is what the author *expected* to go red. Nothing in the schema, and nothing in the send-time check, compares the two, so a probe that reddened the wrong thing is indistinguishable from a probe that worked.

Two live cases in one consumer task on 2026-09-17, both found by a human reading the content of the redness rather than its presence:

1. **A verdict passed for a foreign reason.** A fixture used a relative path; `path.resolve` resolved it against the process working directory rather than the fixture root, so the refusal came from the resolver ("outside the working zones") and never reached the gate under test. The verdict was green even with the gate removed.
2. **A block of verdicts did not run at all.** A bare `readLock` on an invalid file exits the process through `fail()`. Everything below it in the test file — including the whole parity block the change was made for — produced no verdicts. The run was red, but not for the reason claimed.

Case 2 is the more expensive of the two, and the gap widens: a verdict passing for a foreign reason loses one check, while an aborted file silently loses every check below it.

## What to do

Let the record state the intent, and check it where the record is accepted:

- `mutationProbe` gains the name (or names) the author expects to go red, recorded **before** the run.
- The send-time schema check fails the record when the expected name is absent from `reddened`. A probe that reddened only other things is then a refused record, not a passing one.

## Not in scope

- Counting executed verdicts to catch an aborted file, and isolating the fixture root per input. Both are test-suite hygiene and belong to the consumer's own suite, and are recorded in its own tracker.
- Deciding what a runner prints. The record describes what the author did; it does not require a runner to report totals it has no notion of.

## Checks

- A record whose `reddened` does not contain the declared expected name is refused at `send`, with the mismatch named.
- A record that declares an expected name and contains it passes unchanged.
- An existing record without the new field keeps working, or its migration is named explicitly — consumers hold records written by the previous version.
