# PB-203.1 · A participant whose journal record carries no session reference cannot be traced afterwards

- **Order:** 330
- **Scope:** `lib/spawn.js` (what is written into the record when the lift does not return a session), `docs/reference/03-cli.md` § Spawn
- **Created:** 2026-09-12, found while reproducing the PB-203 post-mortem from the recorded store
- **Dependencies:** none

## Context

PB-203 names nine workers that sent no `result` and gives one line of evidence for each, taken from their harness session logs. Eight of those nine logs were found again on 2026-09-12 and the evidence reproduced. The ninth could not be looked for at all: its journal record names no session.

The recount that identified them: 258 worker participants across 74 tasks in `<workspace>/.promptobus/tasks/`, 11 of them with no `result` in the message canon, minus the two participants of the run that was live at the time — nine, split 5 Codex / 2 Cursor / 2 Claude, which is the split the card names.

The one that cannot be traced is `worker:lint` of task `zahod-0904a-gigiena-t20260904-084513`, harness `codex`. Its record has `metadata.started`, `metadata.worktree` and `metadata.name`, and neither `metadata.session` nor `metadata.sessionId`. The other four Codex participants of the nine each carry a `sessionId`, and each resolved to a rollout file under `~/.codex/sessions/` by that id alone. Without one there is nothing to search by: the rollout file names the thread id, not the worktree, and `metadata.name` is a human title the harness does not store.

The card's own table shows the same gap from the other side: it has **eight rows for nine participants**. The missing row is this participant.

The consequence is not this one post-mortem. A participant with no session reference is invisible to every later question about how it ended — which is the question PB-203 exists to answer — and the record gives no sign that anything is missing.

## Work to do

- Establish whether the record was written without a session on purpose (a lift that returned none) or lost it later, and say which in the card. The distinction decides whether the fix is at write time or at read time.
- If a lift can legally return no session, make the record say so in a field rather than by absence, so a reader can tell "this participant never had one" from "this record is incomplete".
- Name the gap where a person would meet it: `promptobus status` prints the session line only when `metadata.name` is present, and says nothing about a missing session reference.

## Out of scope

- Reconstructing this particular participant's session: the evidence for it is gone, and the card is about the next one.
- Any change to how drivers obtain a session id — that is the driver's contract, not the journal's.

## Verification

- A stand participant whose lift returns no session gets a record a reader can recognise as such, and `promptobus status` says it in words.
- A walk over the recorded store finds no participant with `started` but no session reference other than the one named here.
