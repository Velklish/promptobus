# PB-225 · The reviewer is pointed at gate and handover records, not at the evidence artifacts the author attached

- **Scope:** `lib/review.js` (the review subject: `gateRecordsNote`, `handoverRecordsNote`), [03-cli](../../reference/03-cli.md) § Review, [04-protocol](../../reference/04-protocol.md) § Artifacts
- **Created:** 2026-09-16
- **Dependencies:** none; the handover record that narrows the gap is `PB-216`
- **Taken:** 2026-09-17

## Context

Run of 2026-09-16, second wave. Both reviewers of that wave raised round-1 majors of the
shape "no mutation probe on record" while the workers had attached the probe transcripts
minutes earlier as `type=artifact` files (`*-evidence.md`, thirteen probes in one of them).
The files sat in the task files folder; the review subject did not name them, and a reviewer
that reads what its subject names saw no probe. Each false major cost one worker turn that
re-sent what was already on disk, and one reviewer turn to read it.

What the subject names today, read from `lib/review.js`: the diff, "Gate records attached
to this task, read them", "Handover records attached to this task, read them" (since the
handover record landed), and the worktree's untracked files. A file in the task folder that
is neither a record shaped by a schema nor part of the diff is invisible to the reviewer,
however the author labelled it. The reviewers of that run were lifted from the installed
0.9.0 preamble, which names gate records only; the gap is narrower on `main`, not closed.

> Source: 2026-09-16, round-1 reports of two reviewers (majors withdrawn on the next round
> after the workers re-sent the same files), the task files folder listing, `lib/review.js`
> on `main` at `77b382f`.

## Work to do

- Choose one of two contracts and write it down in both the reviewer and the worker
  preambles, in the same words:
  1. the review subject lists every file the reviewed address attached to the task — name,
     type, time — not only the schema-shaped records; or
  2. evidence outside the handover record does not exist for the reviewer, and the worker
     preamble says so where it asks for the record. The handover record argues for this
     one, but its probe field carries one probe, not thirteen — the schema would have to
     grow a list.
- Whichever is chosen, a reviewer report that says "no probe on record" while a probe file
  is attached must become impossible by construction, not by diligence.

## Out of scope

- Forwarding artifacts sent by the orchestrator or by other participants.
- The reviewer reading the bus history instead of the subject.

## Verification

- A lifted reviewer's subject names an `evidence.md` the author attached before `review`
  ran (contract 1), or the worker preamble states that such a file is not evidence
  (contract 2); the test asserts the sentence, and the mutation probe that removes it
  reddens exactly that assertion.
