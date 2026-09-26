# PB-277 · status, sweep, dismiss and stop address step:slug

- **Order:** 140
- **Scope:** [03-cli](../../reference/03-cli.md), `lib/status.js`, `lib/sweep.js`, `lib/dismiss.js`, `lib/stop.js`, `lib/spawn.js` (`refuseParticipantPrefix`)
- **Created:** 2026-09-26
- **Dependencies:** PB-273, PB-274
- **Cost:** major

## Context

Participant files in `workers/` are named by `participantFileStem`: the worker's slug alone, `<role>-<slug>` for the others, and `refuseParticipantPrefix` keeps a worker slug from starting with `reviewer-` or `approver-` because the two would share files. With declared steps the reserved set is the declaration's names, and every address-taking command must accept `<step>:<slug>`.

## Work to do

- `status`, `sweep`, `dismiss` and `stop` accept any address the registry admits; `status` prints steps in declaration order per piece.
- File stems for gate steps are `<name>-<slug>`; `refuseParticipantPrefix` reads the declared names.
- `sweep <step>:<slug>` removes that participant's files, blobs and refs and never the owner's worktree; the keep list of [ADR-016](../../adr/adr-016-cleaning-up-after-one-accepted-piece-is-a-verb-of-its-own.md) is derived per kind.

## Out of scope

- New verbs.

## Verification

- `sweep security:x` removes `workers/security-x.*` and the blobs it sent, and leaves the owner's worktree and branch.
- `spawn --worker security-x` is refused naming the declared step, as `reviewer-x` is refused today.
- `status` on a task with a four-step pipeline prints each piece's steps in declaration order with the usual session state.
