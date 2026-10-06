# PB-353 · Single-participant sweep returns before asynchronous harness cleanup completes

- **Scope:** [CLI — takePiece](../../reference/03-cli.md#takepiece--the-destructive-stretch-under-the-journal-lock), [Drivers — OPENCODE](../../reference/05-drivers.md)
- **Created:** 2026-10-06
- **Dependencies:** none
- **Cost:** major

## Context

The public single-participant sweep invokes the asynchronous OpenCode cleanup hook without awaiting its Promise. The synchronous try/catch cannot catch a rejected asynchronous hook, and the journal lock is released before that hook settles. This is distinct from the participant-selection defect.

Evidence: source re-read 2026-10-06 at main 4483045e. `lib/sweep.js:325` calls takePiece under synchronous withTaskLock; `lib/sweep.js:375` invokes sweepParticipant without await; `lib/driver-opencode.js:423-440` declares an async hook and awaits deletion/reaping; `src/sidecar.ts:376` wraps withDirLock, whose `src/fs/lock.ts:187-200` finally releases the lock when the callback returns. withDirLockAsync already exists at `src/fs/lock.ts:214`, but the task-lock wrapper has no corresponding async surface. Worker source observation independently arrived during participant-cleanup work. Async timing/rejection reproduction is not yet executed; the source-confirmed completion/rejection gap needs that implementation probe.

Named next step: root scope decision on asynchronous task-lock expansion versus a focused participant cleanup; preserve this finding while the independent critical peer-selection fix proceeds.

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
