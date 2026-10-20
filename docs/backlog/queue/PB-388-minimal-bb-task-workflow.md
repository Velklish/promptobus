# PB-388 · Design a minimal BB workflow with one executor and independent review

- **Order:** 350
- **Scope:** [BB workflow](../../reference/01-overview.md), model roles, context delivery and mechanical acceptance
- **Created:** 2026-10-20
- **Dependencies:** owner agreement on the workflow; PB-381, PB-383, PB-384 and PB-387 contracts
- **Cost:** major

## Context

The recovery audit requests a simpler default: one executor and an independent reviewer, with predictable bookkeeping performed by code. Current BB workflow uses distinct worker/reviewer/approver predecessor bindings. `lib/bb-host.js` eagerly gathers full canonical skills/rules and renders them into the initial assignment; fresh phases repeat that context. The old consumer run also used a sponsor, orchestrator and separate acceptance actors.

Evidence: source `5386bd5d6dedd84dd69760cfee4f1c0f19543f87`, `lib/bb-host.js`, `lib/prompts/bb.js`, `bb-plugin-promptobus/runtime.ts` and predecessor admission. The audit sidecar retains original handoffs and cumulative usage, but stage-attributed token savings are notMeasured. This is a design proposal, not proof that every additional role is redundant.

Priority: after correctness blockers, before final efficiency acceptance. The owner must select the architecture before implementation.

## Work to do

Owner clarification, 2026-10-20: internal implementation/review participants should not inherit unrelated prompts or personal writing profiles. Such a profile belongs to user-facing communication or an explicit task to write in the owner's voice. `lib/bb-host.js` already knows the participant role, but calls the consumer's unscoped `collectRules(root)` and eagerly reads every skill. Make selection mechanical and role/task-aware; do not rely on each worker spending tokens to ignore irrelevant text. Core should not hardcode one consumer's personal profile filename.

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
- Use a personal-style sentinel and an unrelated-skill sentinel: neither appears in a technical worker/reviewer assignment or gets loaded by a blanket rule-loading instruction. Required repository rules and explicitly selected skill dependencies remain present.
- User-facing communication and an explicit author-voice writing task still receive the requested style. Context selection never removes authority, permission or ownership rules.
- Separate the Promptobus-rendered payload from BB/provider-inherited instructions and skill discovery. A filter in one layer must not be reported as filtering the other; unavailable official controls remain a named integration dependency.
- Record selected context sources and reasons so actual initial-context/usage comparisons can explain what was removed. Bytes alone are not tokens.
- Compare actual input/cached/output tokens, turns, context transfers and manual interventions on matched baseline/candidate scenarios.
