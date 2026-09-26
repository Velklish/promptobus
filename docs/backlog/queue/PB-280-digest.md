# PB-280 · promptobus digest prints the tree without a model

- **Order:** 170
- **Scope:** [03-cli](../../reference/03-cli.md), `lib/status.js` or a digest module, `lib/history.js`
- **Created:** 2026-09-26
- **Dependencies:** PB-267, PB-278, PB-279
- **Cost:** major

## Context

`status` answers the mechanism's questions — sessions, unread counts, stalls, routing. The person's question is "what is going on and who is waiting for whom", and today the only answer is the orchestrator's own summary in its chat, which competes with everything else the orchestrator does. The owner decided on 2026-09-26 (ADR-022) that a summary without a model is the first channel.

## Work to do

- `promptobus digest [--task <id>]` prints, for the root task and each child: per participant the last `status` first line and its age; open `question` messages with addressee and age, the person's unanswered questions first; stalls and `SILENT` / `UNANSWERED` from the status machinery; pieces by pipeline step with the step that holds each piece now.
- It reads headers (PB-278) and the journal; it never renders a `status` body beyond its first line and never calls a harness.
- `--json` for a page or a script.

## Out of scope

- Answering a question in words: PB-281.
- Anything that needs a model turn.

## Verification

- On a journal with 33 pieces, 86 questions and 329 status messages, the digest prints every piece with its step, every open question with age, and finishes without reading a `status` body past its first line (a read hook counts the bodies).
- On a tree of a root and two children the digest prints three blocks in tree order.
- `--json` validates against the shape the text prints.
