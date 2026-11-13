# PB-441 · Show reviewed subjects and document immutable-harness approver recovery

- **Order:** 670
- **Scope:** [CLI: Review](../../reference/03-cli.md#review), [Overview](../../reference/01-overview.md), [Host](../../reference/02-host.md), [Drivers](../../reference/05-drivers.md)
- **Created:** 2026-11-13
- **Dependencies:** none
- **Cost:** minor

## Context

PB-327 reports a clone-root approver refusal that omits the reviewed worktree and the usable command. PB-416.16 records a different boundary: an existing stopped approver keeps its original harness, and an attempted harness change was refused before native launch. A fresh owned subject with an initially selected harness requires explicit authorization and a verified supported procedure. These two causes and acceptance paths remain separate.

This batch was approved in the 2026-11-13 whole-backlog audit at source `51867619447b812a2a03fc80fa5b271490e5756c`. Its original findings remain open until execution and acceptance. Grouping is not evidence that a hypothesis is confirmed or a defect is fixed.

## Work to do

- When an approver subject lacks the required reviewer, enumerate this task's current review subjects with valid reviewer result messages and show the supported `review <subject> --approver` command for each.
- Add a clone-root regression with a reviewed worktree that checks its actual worktree path and exact suggested approver command, and fails on the old refusal text.
- Verify the supported recovery route before publishing a concrete recipe. Document an explicitly authorized fresh owned same-card subject with its initially selected approver harness, preserving the old failed generation and its missing Stop proof.
- Explain that repeat-reviewer behavior does not establish approver harness mutability. Add a documentation regression against an explanation that suggests switching the old approver's harness or identity.

## Acceptance criteria

- PB-327: an approver lift on the clone root of a task with one reviewed worktree names that worktree and its exact supported `review ... --approver` command in the refusal.
- Subjects are suggested from the task's valid reviewer-result records; an approver still requires a current reviewer result for its own subject.
- PB-416.16: a concrete recovery recipe names only a verified supported route and requires an authorized fresh owned subject with the intended harness selected initially. If the route cannot be verified, retain the uncertainty instead of inventing commands.
- The old stopped approver's harness, identity, failed generation and missing native Stop proof remain intact; the historical pre-launch refusal is not described as a native/model outage.

## Out of scope

- Weakening the reviewer-result gate or suggesting unreviewed/foreign subjects.
- Automatic harness switching, manual participant edits, claims, identity rewrites or silent relift of the old approver.
- New model work or treating the fresh pipeline's evidence as Stop proof for the failed generation.

## Verification

- After implementation, run `npm run build` and the focused approver/review regression covering clone-root refusal, reviewed subject discovery and the exact suggested command; select the existing repository test file when implementing and record its exact command and exit code. These checks are notRun.
- After implementation, run `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs` from the repository root; notRun.
- Verify the concrete fresh-subject procedure through the supported route before asserting it in documentation; notRun. No new model/native run is authorized by this backlog assignment.

## Original findings and retained requirements

### PB-327 — An approver lift on the clone root says no participant is recorded and names no worktree that has a reviewer result

[Complete original finding](../minor/PB-327-approver-subject-refusal-names-no-worktree.md).

- When the subject has no reviewer, list the task's review subjects that carry a reviewer result, each with the `review ... --approver` command for it.
- An approver lift on the clone root with one reviewed worktree must name that worktree path in its refusal. The regression must assert both the worktree and exact command and fail on the old text.
- Preserve the gate: an approver still needs a reviewer result on its subject.

### PB-416.16 — Document recovery when a stopped approver retains its original harness

[Complete original finding](../minor/PB-416.16-immutable-approver-harness-recovery.md).

- Document the role-specific recovery recipe only after verifying the actual supported route: an explicitly authorized fresh owned same-card subject with the desired approver harness selected initially.
- Preserve the stopped approver's original harness, failed generation and missing native Stop proof. Do not edit participant identity, claim it or silently relift the old generation on another harness.
- Keep the historical refusal attributed as a pre-native-launch stock constraint; it establishes no model/native outage. Repeat-reviewer behavior must not be applied to approver harness mutability.
- No harness-mutability change or new model work is admitted by this documentation record; add a regression against the old recovery explanation.

## Next step

Execute this bounded batch in queue order, preserving the separate decision or evidence prerequisites above. Native/account probes retain their own explicit boundaries; queue placement itself grants none.

## Triage disposition, 2026-11-13

The owner requested completion of the remaining triage. This is a scoped queued task with work and verification defined above. Decision/investigation steps precede any dependent implementation; unmeasured claims and explicit authority boundaries remain unchanged.
