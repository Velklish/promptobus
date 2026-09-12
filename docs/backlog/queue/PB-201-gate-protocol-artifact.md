# PB-201 · A worker's gate claim reaches the reviewer as prose, not as a machine record

- **Order:** 1
- **Scope:** `lib/store.js` (`placeFile`, `numberedName`), `schemas/v1/` (new record), `lib/review.js` (reviewer preamble, `addDirs`), `lib/spawn.js` (worker preamble), `docs/reference/04-protocol.md` § Artifacts
- **Created:** 2026-09-12, from a review of 73 bus runs
- **Dependencies:** none

## Context

The reviewer cannot run anything, and that is deliberate: `Edit`, `Write`, `NotebookEdit`, `Bash`, `WebFetch`, `WebSearch` are denied to it, and [ADR-009](../../adr/adr-009-reviewer-resolves-no-discrepancy.md) refuses to loosen that. Measured over 242 reviewer sessions: **0 Bash calls**, 52 % `Read`, 35 % `Grep`. So when a worker writes "gates green, 52/52", the reviewer has no way to tell that claim from a wish. It reads the sentence and moves on.

Somebody still checks, and today it is the orchestrator: **2043 gate runs, 16.8 % of all its Bash calls** across 37 orchestration sessions. The one participant whose attention is the scarcest in a run re-executes what a participant already executed.

> Source: 2026-09-12, transcripts of 37 orchestrator and 242 reviewer sessions; classification script `orch2.py`, `agg2.py` in the session scratchpad. N gate runs 2043 of 12172 Bash calls.

A hand-read sample of 60 reviewer messages (249 findings) shows what this costs. The most repeated cause of a second review round is not disagreement — there was not a single round caused by disagreement or by a misread wording. It is a requirement that can only be checked by a full run the author is not allowed to make: **three repeats in one day, three different authors, three different files**, and the orchestrator named it one mechanism rather than three defects.

The door for a machine record already exists and needs no new permission:

- an artifact is attached to a send (`artifactPath` on `promptobus_send`; `docs/reference/04-protocol.md:85-87` — "there is no separate upload command"), copied into the task and hard-linked into `files/`;
- the reviewer already reads that directory — `lib/review.js:484-486` adds `dirname(diffPath)` to its allowed directories, which is `files/`, otherwise it could not read the diff it is sent;
- `Read`, `Grep` and `Glob` are not denied to it.

What is missing is the record itself: there is no schema for a gate result, and nothing in the worker's preamble asks for one. `lib/spawn.js:551` specifies the whole result body as "outcome + list of changed files".

## Work to do

- Define the record: the exact command as executed, its exit code, the counts the runner printed (files, tests, green), the tree sha the run was made on, the timestamp, and the participant address. One record per gate command, not one per session.
- Have the worker attach it and name it in the result; the reviewer's preamble tells it to read the record and compare the tree sha in it with the sha of what it is reviewing. A record whose sha differs from the reviewed tree is not evidence about that tree.
- Decide and write down what happens when the record is absent or its exit code is not zero — refuse the acceptance, or accept with the gap named. The decision belongs in the card; the mechanism must not silently accept both.
- Keep the record small enough to read: the tail of the output, not the whole log. There is no size limit anywhere on artifacts today (`grep` for a size bound in `src/`, `lib/` and the protocol reference returns nothing), so the bound has to be stated here.

## Out of scope

- Giving the reviewer a way to run gates: refused by [ADR-009](../../adr/adr-009-reviewer-resolves-no-discrepancy.md), and this card exists because that refusal stands.
- The header of the result body — PB-204.
- The `faults` seam of `listArtifacts` — [PB-146.3](../deferred/PB-146.3-list-artifacts-without-faults-seam.md), which returns when this card touches `src/v1/artifacts.ts`.

## Checks

- A worker that ran gates attaches the record; a reviewer session, with its usual deny list, reads it and quotes the exit code back. Live run, not a fixture.
- Mutation probe on the comparison: a record whose tree sha does not match the reviewed tree is reported by the reviewer as not-evidence; with matching sha the same record passes. Both directions, or the check proves nothing.
- A record claiming exit code 0 for a tree whose tests actually fail is caught by the sha comparison, not by trust — demonstrate on a stand.
- The reviewer's permissions are unchanged: the deny list in its settings file is byte-identical before and after.
