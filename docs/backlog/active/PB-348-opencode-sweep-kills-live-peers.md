# PB-348 · Sweeping one OpenCode participant terminates live peers in the same task

- **Scope:** [05. Drivers — OPENCODE](../../reference/05-drivers.md)
- **Created:** 2026-10-06
- **Dependencies:** none
- **Cost:** critical
- **Previous order:** 40
- **Taken:** 2026-10-06

## Context

The single-participant sweep dispatcher invokes the OpenCode driver with the selected participant. The driver ignores that participant and filters registry records only by task id, then deletes sessions and reaps holders for every match, including live peers.

Evidence: 2026-10-06, Promptobus HEAD 450f0d265553fac9973d5db74917195b03291cd9. `lib/sweep.js:375` calls `sweepParticipant(p, id)`; `lib/driver-opencode.js:423-440` ignores p and reaps all task records. Root preflight mock reproduction `node /Users/kim.p/AtiWorkspace/workspace/.promptobus/tasks/codex-backlogs-t20261006-134126/files/repro-opencode-sweep.mjs` returned exit 0: before live peer alive=true/record=true; sweeping worker:accepted returned swept=2; after peer alive=false/record=false. Only an isolated dummy Node process and temporary registry were used, no live OpenCode model turn or existing run touched. Isolated reviewer report checkpoint: 20261006T135436117-0003-bcf3f0.

## Work to do

- [ ] Restrict the participant cleanup hook to the selected participant's owned record/session/holder.
- [ ] Keep closed-task cleanup complete through an explicit task-level path or per-participant iteration.
- [ ] Cover single-participant sweep with a live peer, another task, and repeated cleanup; peer must survive.
- [ ] Update the driver reference and cleanup contract in the same change.

## Out of scope

- OpenCode root ownership, model routing, and unrelated harness cleanup.

## Verification

- [ ] A mock live peer in the same task remains alive with its registry record after sweeping an accepted/dead participant.
- [ ] Closed-task cleanup removes only that task's owned holders/records; other task is preserved.
- [ ] Relevant driver, sweep and done checks pass; regression test fails on the old implementation.
