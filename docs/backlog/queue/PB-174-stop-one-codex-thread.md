# PB-174 · No door to stop a single Codex thread: `done` kills the task and `dismiss` leaves the holder running

- **Order:** 100
- **Scope:** `lib/driver-codex.js`, `lib/codex-session.js` (the holder registry), `bin/` (a command
  or a flag), [03-cli](../../reference/03-cli.md) § Status, done, dismiss, history, prune
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

Found 2026-09-12 by a worker measuring the parity of the orchestrator. It had raised two
participants of one measurement task — Cursor and Codex — and needed to stop **one** of them.

There is no command for that:

- `promptobus done` closes the task and stops every session in it, the other participant
  included;
- `promptobus dismiss <address>` stops watching the participant and never touches its process —
  it says so itself, and it is the right behaviour for what it is.

So the worker killed the holder by hand, from the pid in the registry record
(`~/.agents/codex/sessions/worker-codex-0911-2320-43ac2587fa15.json`): `holderPid 2214` and
`appPid 2216`, both gone from `ps` after `kill`. It named the workaround rather than reporting
success, which is how this card exists.

**Two costs, and the second is worse than the first.**

1. **Memory.** The holder was 45 MB RSS and its `app-server` 127 MB; stopping it freed 172 MB
   on a machine already at 89.3 % swap under four workers. A participant that cannot be stopped
   individually stays for the life of the task.
2. **A registry record left lying.** After the manual `kill` the record stayed at
   `state: alive` — an orphan that only `done` on the measurement task will clear. Anything
   reading the registry for liveness now reads a lie, which is exactly the defect `PB-175`
   describes for a neighbouring file.

The parity table in the orchestration skill carries "no" in this cell as a word. This is the
measurement behind that word.

## Work to do

- Give the mechanism the missing door: stop one participant's session without closing the task.
  It belongs beside `dismiss` in meaning but must not be `dismiss` — that word already promises
  "stop watching, do not touch the process", and two behaviours under one name is worse than a
  second name.
- Whatever stops a Codex thread must also **retire its registry record**, not leave it at
  `state: alive`. A stop that leaves a lie behind has not finished.
- Say in the reference what each of the three commands does to a process, in one place. Today
  the boundary between `done`, `dismiss` and "kill it yourself" is learned by hitting it.

## Out of scope

- `done` and `dismiss` themselves: both do what they promise.
- The holder's own lifecycle for Claude Code and Cursor — the gap measured here is Codex, and
  whether the other two have the same one is a question for the same pass, not an assumption.

## Verification

- One participant of a two-participant task is stopped, the other keeps working, and the task
  stays open.
- The registry record of the stopped thread no longer reads `state: alive`.
