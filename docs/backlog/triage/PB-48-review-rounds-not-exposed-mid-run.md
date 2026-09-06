# PB-48 · tallies() already computes reviewRounds from the message journal but is exported only through promptobus done, so the orchestrator's step-up-after-two-rounds rule requires counting review messages by hand for the whole run

- **Scope:** [reference/03-cli](../../reference/03-cli.md) (Participant Telemetry, Status, done, dismiss...), `lib/model-routing/telemetry.js`, `lib/status.js`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`skills/orchestrate/SKILL.md:151` ("Step up after two rounds") reads "Two review rounds on one worker with no progress ... mean the model is under the task. Step up once, and only once..." — a rule keyed on a count the orchestrator has to track itself, across turns and possibly a context compaction.

`tallies()` in `lib/model-routing/telemetry.js:149` already walks the canonical message journal and builds `{ turns, reviewRounds, questions, resultCount }` per participant, incrementing `reviewRounds` at line 181 on each `review`-typed message. It carries no `export` keyword, and its only caller is `telemetryRecords` (`lib/model-routing/telemetry.js:263-267`), which is called only by `appendTelemetry` (`lib/model-routing/telemetry.js:324`), which is called only from `lib/done.js:291` — i.e. only at `promptobus done`, after the task is over.

`lib/status.js`'s participant line prints only `unread N` (`unreadPart`, lines 147-149, wired at line 219) plus routing/session state — no traffic counts. `docs/reference/03-cli.md:665` confirms: `status` lists "active tasks, participants, unread counts, and warden health", nothing about rounds or turns.

## Work to do

- Export `tallies` from `lib/model-routing/telemetry.js` — it already reads only sender/recipient/type off the message envelope, the same privacy-safe surface `PB-36`'s participant telemetry record already exposes at `done`.
- In `lib/status.js`, call it per participant when building the participant line and append a fragment such as `rounds 2 · questions 1 · results 3` beside the existing `unread N` part, omitted when all three are zero.
- Document the addition in `docs/reference/03-cli.md`'s `status` description (around line 665).
- Drop the hand-counting expectation from `skills/orchestrate/SKILL.md`'s "Step up after two rounds" section (line 151) now that the count is printed; the judgment that stays with the orchestrator is only the other half of the rule — whether a round showed progress.

## Out of scope

- Any change to what counts as a review round, or to the step-up decision itself — this only surfaces a count the message journal already determines.

## Verification

- On a task with two `review` messages sent to one worker, `promptobus status` prints `rounds 2` on that participant's line before `promptobus done` runs.
- On a task with none sent, the rounds/questions/results fragment is omitted from that participant's status line.
