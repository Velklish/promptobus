# PB-274 · promptobus step lifts a gate step by name on a machine precondition; review and review --approver become its aliases

- **Order:** 110
- **Scope:** [03-cli § Review](../../reference/03-cli.md#review), `lib/review.js`, `lib/approver.js`, `lib/liftoff.js`, `lib/cli.js`
- **Created:** 2026-09-26
- **Dependencies:** PB-273
- **Cost:** major

## Context

Two lifts exist for the two gate roles: `review <path>` for the reviewer, `review <path> --approver` for the approver with the precondition of [ADR-015](../../adr/adr-015-approver-lift-is-a-flag-on-review.md) — a `result` from `reviewer:<slug>` at or after its current assignment, at the same subject. A declared pipeline (PB-273) has any number of gate steps, each lifted by the teamlead when it decides to move on: the owner chose on 2026-09-26 that transitions stay the orchestrator's hand and that the bus checks preconditions only (ADR-020). The bus forms no verdict ([ADR-009](../../adr/adr-009-reviewer-resolves-no-discrepancy.md)).

## Work to do

- `promptobus step <name> <path> --task <id> [--base <ref>] [--brief <file>] [routing flags] [--dry-run]` lifts `<name>:<slug>` for the piece derived from the subject, with the kind's cwd and rights (PB-275).
- Preconditions, all machine facts: the first gate has none; gate N requires a `result` from the participant of gate N−1 at the same subject at or after that participant's current assignment; a `writes-main-tree` step additionally requires a `result` from the owner step of the piece. A refusal names the missing record.
- `review <path>` is `step <first reads-diff gate>` and `review <path> --approver` is `step <first writes-main-tree gate>`; both print the step they lift and are refused when the declaration has no such step.
- A repeat `step` to a live participant sends a fresh snapshot, as `review` does; re-bind on a dead session keeps the harness history as today.

## Out of scope

- Lifting the next step automatically on a `result`: rejected by the owner.
- The owner step: `spawn` lifts it and is unchanged here.

## Verification

- Pipeline `reviewer`, `security`, `approver`: `step approver` is refused without a `result` from `security:<slug>` and passes after it; `step security` is refused without a `result` from `reviewer:<slug>`.
- Pipeline with `approver` only: `step approver` is refused without the owner's `result`, passes after it.
- `review` and `review --approver` print the step name and behave as before on the default pipeline; with no `reads-diff` step declared, `review` is refused naming the declaration.
