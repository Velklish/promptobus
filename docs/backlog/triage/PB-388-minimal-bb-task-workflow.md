# PB-388 · Design a minimal BB workflow with one executor and independent review

- **Scope:** [BB workflow](../../reference/01-overview.md), model roles, context delivery and mechanical acceptance
- **Created:** 2026-10-20
- **Dependencies:** owner agreement on the workflow; PB-381, PB-383, PB-384 and PB-387 contracts
- **Cost:** major

## Context

The recovery audit requests a simpler default: one executor and an independent reviewer, with predictable bookkeeping performed by code. Current BB workflow uses distinct worker/reviewer/approver predecessor bindings. `lib/bb-host.js` eagerly gathers full canonical skills/rules and renders them into the initial assignment; fresh phases repeat that context. The old consumer run also used a sponsor, orchestrator and separate acceptance actors.

Evidence: source `5386bd5d6dedd84dd69760cfee4f1c0f19543f87`, `lib/bb-host.js`, `lib/prompts/bb.js`, `bb-plugin-promptobus/runtime.ts` and predecessor admission. The audit sidecar retains original handoffs and cumulative usage, but stage-attributed token savings are notMeasured. This is a design proposal, not proof that every additional role is redundant.

Priority: after correctness blockers, before final efficiency acceptance. The owner must select the architecture before implementation.

## Work to do

- Specify a default with an executor model and a fresh independent reviewer model. Integration bookkeeping and required checks remain explicit, but do not require another model solely to repeat metadata.
- Preserve author/reviewer independence and exact reviewed source binding. An executor must not approve its own semantic review.
- Use existing engine, BB adapter and tracker functions for preparation, receipts, admission, state projection and closure; avoid another wrapper platform.
- Deliver bounded mandatory task/role context and selectively accessible skill/rule dependencies. Preserve required instructions and source references; do not solve size by truncation.
- Keep additional roles optional when a concrete responsibility needs them; align duplicated consumer guidance after selecting the package contract.

## Out of scope

- Unconditional deletion of role support, review checks or useful provider integrations.
- Treating metadata as permission, widening filesystem roots, or promising savings before matched measurements.

## Verification

- A task with review findings uses the agreed default roles and reaches exact-source acceptance without a model-only packaging phase.
- Wrong source, stale review, failed required check and denied permission still prevent acceptance.
- A reviewer receives the current full diff and relevant prior findings without the author's private reasoning.
- Large unrelated skills/history do not inflate initial context or current closure; required referenced rules remain readable.
- Compare actual input/cached/output tokens, turns, context transfers and manual interventions on matched baseline/candidate scenarios.
