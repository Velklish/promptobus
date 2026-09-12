# PB-207 · Nothing says a status needs no reply, and the guard promises one

- **Order:** 100
- **Scope:** `lib/guard.js` (verdict text), `lib/spawn.js` and `lib/review.js` (preambles), `docs/reference/04-protocol.md` § Message types
- **Created:** 2026-09-12, from a measurement of bus latency
- **Dependencies:** none

## Context

`status` is the most frequent type on the bus — 2167 messages against 1151 results — and it is the only one with no defined expectation. The code never reads a type to decide whether an answer is due: the type is read only by the telemetry tally, which counts questions, results and review rounds, and does not count `status` at all.

In practice the orchestrator answers them, and that is where the wall-clock goes: median 17.6 minutes to answer a status, p90 133 minutes, against 7.6 minutes median for a `question`. Of 1424 measured waits, 1011 were waits for an answer to a status.

> Source: 2026-09-12, `latency.py` and `block.py` in the session scratchpad over `<workspace>/.promptobus/tasks/*/messages/*.json`.

One text says the opposite of the design. The guard's verdict tells a participant to fetch its messages "and reply in your role" (`lib/guard.js:104-111`), while the verdict itself is built from the unread count alone. The promise is broader than the check.

One trap must not be broken while fixing this. The supervisor escalates a participant to `SILENT` on an **unread** inbox, and the orchestrator is recorded as an ordinary participant, so that escalation applies to it and is covered by a test. Making `status` one-way must not turn into "the orchestrator may stop reading".

## Work to do

- Write in the protocol reference which types expect an answer — `question` and the hand-over that asks for acceptance — and which do not.
- Make the two preambles say the same thing, so a participant does not wait for an acknowledgement that is not coming.
- Fix the guard's text or its verdict so they agree; the fix belongs to whichever is cheaper, and the card says which was chosen.

**Widened during the work, 2026-09-12, deliberately and not by reading.** This card names two kinds that expect an answer — a `question` and the hand-over that asks for acceptance. The table as built names four: `task`, `question`, `review`, `result`; `status`, `answer` and `artifact` expect none.

The two extra kinds are not tidiness. Of the nine participants that PB-203 is built on, the ones that ended a turn cleanly and sent nothing had exactly one inbound message in their whole life, and it was a `task` or a `review`. With the table at two kinds the gate of PB-203 is dead on six of those nine — that is, on the very evidence it grew from. The widening is recorded here so that a later reader narrowing the table back knows it would be undoing a decision rather than fixing an oversight.

## Out of scope

- A mechanical "awaiting an answer" counter: that changes the shape of `health.json` and the supervisor's contract, and the opposite gap — a turn ending with nothing sent — is PB-203.
- Any change to the escalation trigger itself.

## Checks

- The reference names the expectation per type, and a grep finds no text still promising a reply to a status.
- The `SILENT` escalation test stays green, and a stand run where the orchestrator reads but does not answer statuses produces no stall and no escalation.
- A run measured after the change shows the count of status-answers dropped, with the before and after numbers named.
