# PB-353 · Single-participant sweep returns before asynchronous harness cleanup completes

- **Scope:** [CLI — takePiece](../../reference/03-cli.md#takepiece--the-destructive-stretch-under-the-journal-lock), [Drivers — OPENCODE](../../reference/05-drivers.md)
- **Created:** 2026-10-06
- **Dependencies:** none
- **Cost:** major

## Context

The public single-participant sweep invokes the asynchronous OpenCode cleanup hook without awaiting its Promise. The synchronous try/catch cannot catch a rejected asynchronous hook, and the journal lock is released before that hook settles. This is distinct from the participant-selection defect.

Evidence: source re-read and deterministic mock measured 2026-10-06 at `56ee7d4930f2e19739386e44d7684b62245668f0`. `lib/sweep.js:325` calls takePiece under synchronous withTaskLock; `lib/sweep.js:375` invokes sweepParticipant without await; `lib/driver-opencode.js:423-440` declares an async hook and awaits deletion/reaping; `src/sidecar.ts:376` wraps withDirLock, whose `src/fs/lock.ts:187-200` finally releases the lock when the callback returns. withDirLockAsync already exists at `src/fs/lock.ts:214`, but the task-lock wrapper has no corresponding async surface. Worker source observation independently arrived during participant-cleanup work. Deterministic mock reproduction executed 2026-10-06 by both worker and teamlead, `node <standalone-repro.mjs> <checkout>` exit 0: public sweep returned callerCode 0 while the hook Promise remained pending; .lock was present inside the hook and absent on return. A controlled hook rejection was caught by the fixture, not the caller: callerWarnings was empty. No live harness/model/process was used; this proves caller completion and rejection handling, not an actual holder-cleanup race.

Named next step: after the participant-selection fix is accepted, check an asynchronous task-lock proposal using existing withDirLockAsync, preserving cache-suspension lifetime, public callers, relift guard and named rejection outcome; then implement with independent review and acceptance. This remains ready work, not permanent deferral.

## Work to do

- Decide how single-participant sweep awaits asynchronous harness cleanup while preserving its journal-lock protection against relift.
- Handle rejected hooks through the documented cleanup warning/failure path rather than leaving an unobserved Promise.
- Test a delayed hook and a rejecting hook through public sweep; verify completion, lock retention and concurrent relift behavior.
- Update CLI and driver cleanup reference in the same change.

## Out of scope

- Participant-selection fixes and other cleanup redesign.

## Verification

- Public sweep does not claim completed harness cleanup before a delayed hook settles.
- A rejected hook has a named outcome and does not produce an unhandled rejection.
- A concurrent relift cannot borrow a prematurely released task lock during destructive cleanup.
- Regression probe red on the old code, green after the fix; repository gates and tracker lint pass.
