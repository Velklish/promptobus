# ADR-020: Roles and steps come from one registry, and the delivery pipeline is declared

**Status:** Proposed
**Date:** 2026-09-26
**Deciders:** the owner, in the planning dialogue of 2026-09-26. The text is drafted by the planning session and is not yet reviewed by the owner; the status turns Accepted when PB-273 and PB-274 land.

## Context

The order worker, then reviewer, then approver exists only in prose. The bus knows three lifts — `spawn`, `review`, `review --approver` — and a closed address regexp, while [ADR-013](adr-013-approver-is-a-fourth-addressed-participant.md) records that the fourth role cost about ten independent edits of one contract. The owner wants a person to add, remove and reorder the steps that follow the hand-over to a worker — a second read-only review, no review at all — as the expected way of working, with one declaration per installation and no override by a repository or a task.

## Options

**Decision 1 — how free a step is.**
- 1A. A step is an instance of one of three kinds of right — `edits-tree`, `reads-diff`, `writes-main-tree` — and the kind decides cwd, deny list, quality floor and direct route; the person names the step, its position, an optional standing instruction and an optional floor.
- 1B. A free role with its own rights and prompt. Rejected: every such role needs its own deny list and its own safety review, and a mis-declared one removes the read-only guarantee of review ([ADR-009](adr-009-reviewer-resolves-no-discrepancy.md)).
- 1C. Reorder and remove the three existing steps only. Rejected: it cannot add a security review.

**Decision 2 — where the declaration lives.**
- 2A. `pipeline` in the installation's `promptobus.json`, one per installation.
- 2B. With repository and per-task overrides. Rejected by the owner: the package is one thing placed in one place, and a third source of truth would have to be printed by every command.

**Decision 3 — who moves a piece between steps.**
- 3A. The orchestrator lifts each gate step by name; the bus checks a machine precondition — the previous step's `result` on record — and forms no verdict.
- 3B. The bus lifts the next step when a `result` arrives. Rejected: a red review also arrives as a `result`, and the bus would be deciding to go on without reading it.

**Decision 4 — the roles' source of truth.**
- 4A. One registry declares governance roles and step kinds with every surface keyed to it; declared step names are admitted through it.
- 4B. Edit the copies once more. Rejected by ADR-013's own count.

## Decision

1A, 2A, 3A, 4A. Exactly one owner step of kind `edits-tree`; gate steps in a linear order; a `writes-main-tree` step always requires the owner's `result`; `review` and `review --approver` remain as aliases of the first step of their kind. Absent a declaration, the pipeline is today's and nothing changes for an existing installation.

## Consequences

- Adding a role or a step becomes one registry entry plus tests; the parity test enumerates the surfaces.
- Removing the review step is legal and removes the review gate; the mechanism keeps only the precondition on the owner's result and prints such a pipeline distinctly.
- Two writers in one worktree stay refused; a measured need for a second editing step is the return condition.
