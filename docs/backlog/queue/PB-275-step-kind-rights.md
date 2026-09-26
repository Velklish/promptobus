# PB-275 · A step's kind decides its cwd, deny list and direct route

- **Order:** 120
- **Scope:** [04-protocol](../../reference/04-protocol.md), [02-host](../../reference/02-host.md), `lib/store.js`, `lib/review.js`, `lib/approver.js`, `src/host.ts` (`participantDenyTools`)
- **Created:** 2026-09-26
- **Dependencies:** PB-273, PB-274
- **Cost:** major

## Context

A reviewer is read-only on a snapshot of the diff ([ADR-009](../../adr/adr-009-reviewer-resolves-no-discrepancy.md)); an approver works at the clone root with the worker's worktree attached and an empty package deny list ([ADR-013](../../adr/adr-013-approver-is-a-fourth-addressed-participant.md), [ADR-015](../../adr/adr-015-approver-lift-is-a-flag-on-review.md)); a worker edits its worktree. Those three shapes are the three kinds of ADR-020, and a declared step inherits its kind's shape rather than declaring one of its own.

## Work to do

- `reads-diff`: snapshot cwd, the reviewer deny lists byte-for-byte, orchestrator-only route. `writes-main-tree`: clone root with the owner's worktree attached, the approver deny handling, and the direct route with the owner step. `edits-tree`: the worker's worktree and rights.
- `participantDenyTools(kind)` and the host answer are keyed by kind; a host that classifies by role keeps working through the registry mapping (PB-266).
- The routing exception of `worker` ↔ `approver` becomes owner ↔ `writes-main-tree` step; since PB-273 admits one such step, the exception stays a single pair.

## Out of scope

- New rights for any kind, and any fourth kind.

## Verification

- A participant `security:<slug>` of kind `reads-diff` receives the reviewer deny lists byte-for-byte and cannot attach a file; its `question` to `worker:<slug>` is refused with the orchestrator route.
- A `writes-main-tree` step and the owner write to each other directly; a `reads-diff` step and the owner do not.
- The existing reviewer and approver tests pass unchanged on the default pipeline.
