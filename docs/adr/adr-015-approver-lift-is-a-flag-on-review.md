# ADR-015: Approver lift is a flag on `review`, not a separate verb

**Status:** Superseded by [ADR-024](adr-024-approver-acceptance-in-own-worktree.md) for working directory, concurrency and harness count; the lift command and reviewer-result precondition remain accepted.
**Date:** 2026-09-13
**Deciders:** the run's orchestrator, under the owner's decision of 2026-09-13 that the approver is lifted by a flag on the existing lift rather than a new CLI verb. **Not reviewed by the owner**: this line distinguishes the owner's fixed fork from the implementation choices recorded here.

## Context

[PB-206](../archive/LOG.md#pb-206) made `approver:<slug>` addressable, but no command created that address. The consumer's acceptance procedure had to stay in the descriptive tense until the package could lift the role.

Two shapes were visible: a verb beside `spawn` and `review`, or a flag on an existing lift. [ADR-012](adr-012-stopping-one-participant-is-a-verb-of-its-own.md) refused a flag on `done` and `dismiss` for stopping one participant — that decision must be re-read before reusing a flag here.

The lift also needs a machine precondition and a working directory. The package forms no review verdicts ([ADR-009](adr-009-reviewer-resolves-no-discrepancy.md)); any gate it cannot check must not be written as if it could.

## Options

**A — `promptobus review <path> --task <id> --approver`.** Reuses the review command's repository resolution, routing surface and liftoff path; the flag selects approver lift instead of reviewer lift.

**B — `promptobus accept …` or another verb beside `spawn` and `review`.** Rejected: a third lift verb duplicates path resolution, routing hooks, dry-run printing and driver prepare wiring already shared by `review`.

**C — flag on `spawn`.** Rejected: approver acceptance follows a reviewer result, not a worker brief; `spawn` has no reviewer-result precondition and would mis-place the lift in the run order.

## Decision

**A.** `promptobus review <path> --task <id> --approver` lifts `approver:<slug>` for the worker/reviewer slug derived from the review subject.

**Why ADR-012 does not forbid this flag.**

- **B — two behaviours under one name.** ADR-012 rejected `dismiss --stop` because `dismiss` was documented as watch-only in the same release. `review --approver` does not add a second silent behaviour: the flag is named on the command line, `--dry-run` prints an approver plan rather than a diff, and help states that `--approver` does not start a reviewer.
- **C — a subset flag on a whole-task verb.** ADR-012 rejected `done --only` because `done` promises to close the task, sweep worktrees and append telemetry — every promise would become conditional. `--approver` does not shrink what `review` without the flag promises; it selects a different participant lift with its own plan.
- **D — hand kill.** Not applicable; this card adds a lift, not a stop.

**Precondition — machine fact, not a verdict.** The command refuses when the task journal has no `type=result` from the matching `reviewer:<slug>` at or after that reviewer's current assignment — `metadata.reviewAssignedAt`, stamped from the sent `type=task` message on re-review and from lift on a fresh reviewer, or `metadata.started` on older records — **and** that reviewer participant's recorded `repoAbs` equals the supplied review subject. An older result from a prior review round or another same-slug repository does not satisfy the gate. The mechanism does not read the result body and does not judge the review green.

## Consequences

- Orchestrators lift an approver with the same command that resolves the review subject, adding `--approver` after a reviewer result is on record at that subject.
- Package texts that promised a green review as if the mechanism checked it are replaced by the reviewer-result precondition or by consumer-side procedure.
- `spawn --worker approver` and the `reviewer-`/`approver-` sidecar prefixes stay reserved; the new path does not open them.
