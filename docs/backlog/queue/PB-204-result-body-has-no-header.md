# PB-204 · The result body is free text, so the orchestrator reads all of it to find four facts

- **Order:** 4
- **Scope:** `lib/spawn.js` (worker preamble), `lib/review.js` (reviewer preamble), `docs/reference/04-protocol.md` § Message types
- **Created:** 2026-09-12, from a measurement of 5241 bus messages
- **Dependencies:** none

## Context

The assignment is light and the report is heavy. Across 73 runs: a `task` body has a median of 1340 characters, a `result` body **5254**, with p90 9870 and a maximum of 28 593. In total the results carry 6.57 M characters — roughly 1.6 M tokens — and the statuses another 2.58 M.

All of it converges on one session. The orchestrator receives 2921 messages from workers and 489 from reviewers against 1831 it sends: it is the only reader of that volume, and it reads sequentially.

> Source: 2026-09-12, `<workspace>/.promptobus/tasks/*/messages/*.json`; script `bus.py` in the session scratchpad. N results 1151, N statuses 2167, N tasks 422.

What the orchestrator actually needs from a result to act is four facts: what was done, whether the gates were green and with which exit code, what is left open, and what needs a decision. Everything else it needs only when something diverges.

The whole specification of the body today is one line in the worker's preamble — "outcome + list of changed files" (`lib/spawn.js:551`) — and the schema requires of a body only that it is non-empty (`schemas/v1/message.schema.json:38-41`). The reviewer's line is the same shape (`lib/review.js:1183`).

Two consequences worth naming. The orchestrator re-reads: 43 % of its `Read` calls are repeat reads of a file it already read. And a result that arrives as a wall of prose is where an unproven claim hides best — which is the other half of PB-201.

## Work to do

- Fix the head of a result: what was done / the gate command with its exit code / what is left open / what needs a decision. Bound it in characters, so it stays a header and not a second report.
- Say where the rest goes: the body beyond the header is attached as an artifact, the header names it. The door already exists (`artifactPath` on send).
- Write the rule where the participant actually reads it — the preambles in this package, not in a consumer's rules. A convention that lives only in the caller's own rules is not delivered to a participant lifted by the package.
- Decide what the header does when a gate was not run at all: an explicit "not run, because …" line, not an omitted one.

## Out of scope

- The machine record of the gate itself — PB-201; this card only reserves the line that points at it.
- Adding fields to the message schema: the type list is frozen deliberately ([PB-131](../../archive/PB-131-message-types-mutable-array/task.md)), and the header is a convention inside `body`, not a new field.
- The orchestrator's own reading habits — a consumer-side concern.

## Checks

- A live run where every participant's result opens with the header, and the orchestrator's own report states how many bodies it had to open beyond the header. Before and after, on comparable runs.
- Median header length measured and compared against the bound; a header longer than the bound is a defect of the rule, not of the participant.
- The rule survives the harness boundary: a Codex and a Cursor participant produce the same header shape as Claude, checked on one run each.
- Nothing in the schema changed: `message.schema.json` is byte-identical.
