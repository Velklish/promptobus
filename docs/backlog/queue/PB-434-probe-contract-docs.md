# PB-434 · Clarify mutation probe restoration and wrapper exit statuses

- **Order:** 610
- **Scope:** [Protocol reference](../../reference/04-protocol.md)
- **Created:** 2026-11-13
- **Dependencies:** none
- **Cost:** minor

## Context

The audit at 51867619447b812a2a03fc80fa5b271490e5756c found two descriptions of the same wrapper contract that disagree with its implementation. The probe snapshots file contents and restores those bytes; the clean committed baseline remains an intentional gate. The protocol reference omits the wrapper refusal/cutoff status. This batch assigns PB-419.1 and PB-419.11 without closing their original records.

This batch was approved in the 2026-11-13 whole-backlog audit at source `51867619447b812a2a03fc80fa5b271490e5756c`. Its original findings remain open until execution and acceptance. Grouping is not evidence that a hypothesis is confirmed or a defect is fixed.

## Work to do

- Correct the comment and refusal message in `scripts/mutation-probe.mjs` to explain the committed clean baseline and snapshot restoration.
- Document wrapper outcomes 0, 1 and 2 in the protocol reference, separately from the inner command's `mutatedRunExit`.
- Add separate regressions for the old Git-restore explanation and the old all-other-outcomes-exit-1 wording; retain existing behavior assertions.

## Acceptance criteria

- PB-419.1: the message describes the current contract; dirty work is refused before mutation and pre-mutation content is restored byte for byte.
- PB-419.11: the reference agrees with the dirty-tree and cutoff regressions and distinguishes the wrapper result from the mutated command result.
- Clean-baseline, dirty refusal, cutoff and snapshot-restore behavior remain covered.

## Out of scope

- Changes to mutation-probe semantics or the clean-tree requirement.
- Scanner expansion in PB-419.3.
- Native or live execution and retrospective runtime proof from source inspection.

## Verification

- After implementation, run `npm run build` and `node test/mutation-probe.test.mjs` from the repository root; notRun.
- After implementation, run `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs` from the repository root; notRun.

## Original findings and retained requirements

### PB-419.1 — Correct mutation probe restoration explanation

[Complete original finding](../minor/PB-419.1-correct-mutation-probe-restoration-explanation.md).

- Correct the comment and refusal message to explain the committed clean baseline and snapshot restoration. Preserve the clean gate and byte-identical restore.
- The message must describe the current contract; dirty work is refused before mutation and pre-mutation content is restored.
- Run `npm run build`, `node test/mutation-probe.test.mjs`, `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs` after implementation; notRun.

### PB-419.11 — Document mutation probe refusal exit status

[Complete original finding](../minor/PB-419.11-document-mutation-probe-refusal-exit-status.md).

- Document wrapper outcomes 0, 1 and 2, distinguishing the inner mutated command result.
- The reference must agree with the dirty-tree and cutoff regressions.
- Run `npm run build`, `node test/mutation-probe.test.mjs`, `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs` after implementation; notRun.

## Next step

Execute this bounded batch in queue order, preserving the separate decision or evidence prerequisites above. Native/account probes retain their own explicit boundaries; queue placement itself grants none.

## Triage disposition, 2026-11-13

The owner requested completion of the remaining triage. This is a scoped queued task with work and verification defined above. Decision/investigation steps precede any dependent implementation; unmeasured claims and explicit authority boundaries remain unchanged.
