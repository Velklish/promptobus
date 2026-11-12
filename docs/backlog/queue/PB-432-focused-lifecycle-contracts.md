# PB-432 · Run focused lifecycle and adapter contracts before full acceptance

- **Order:** 440
- **Scope:** [Host lifecycle](../../reference/02-host.md), [Contributing](../../guides/contributing.md)
- **Created:** 2026-11-13
- **Dependencies:** none
- **Cost:** major

## Context

The existing `test:local` builds first and selects conservative groups from an
explicit Git base. Its production map covers fuzzy matching and two model-routing
modules; an unmapped lifecycle change falls back to the full suite. The release
cycle needs a small, explicit first check for neighbouring lifecycle contracts.

Evidence: `test/groups.mjs` and `scripts/test-local.mjs` at
`fe2d59e89e7dbe8061a14432a0d671771cf687d2`. In the retained 0.32.9 release
receipts, candidate `11725cbe8b5f5589924b750871677f1aafc83d9f` failed
`lead-lifecycle.test.mjs` and `promptobus-adapter.test.mjs` during a 432.281 s
full-gate attempt. Each file then failed twice in isolation (exit 1/1); both
passed on base `02c8db947b097f2e36c05ceef65c7136f67b7b42` (exit 0).
The repairs passed both files. The first regression sent dead-root recovery
through self-Stop; the second crossed the adapter import boundary.
Raw historical evidence: `recovery-pb-full-gates-11725cbe.log` and the
`recovery-pb-red-{lead-lifecycle,promptobus-adapter}.test-{1,2}.log` receipts
retained by the 2026-11-13 release audit.

## Work to do

- Extend the existing local selection mechanism with an explicit, reviewed
  lifecycle contract set: Stop/retirement, lead lifecycle, adapter boundaries
  and the affected scenario/documentation checks. Reuse its build-first path.
- Keep the mapping small and explain each production-path-to-test association.
  List selected and omitted files and the reason for selection before execution.
- Preserve conservative full-suite fallback for unknown/shared changes. Provide
  a direct focused invocation for an implementer to run before full acceptance;
  its successful result does not replace the final configured gates.
- Document when to use the focused set and retain one full acceptance of the
  final candidate after source, writer and release-metadata edits are complete.

## Out of scope

- A general dependency-analysis service, reducing final acceptance coverage,
  reusing results from another SHA, or changing production lifecycle behavior.
- Performance changes to the expensive scenario bodies themselves.

## Verification

- Selection tests prove that representative Stop/retirement changes include both
  historical failing files and the documented neighbouring contracts. Unknown,
  shared and unmapped paths still select the full suite; output names omissions.
- With controlled regressions equivalent to both 0.32.9 failures, demonstrate
  that the focused invocation fails before starting a sentinel full-suite run.
  An unchanged candidate then passes after restoring the fixes.
- Prove that execution rebuilds generated output before testing and that `--list`
  remains read-only. Run mutation probes for new selection guards after commit.
- Record focused and full elapsed time on the same candidate/runtime. Run all
  configured gates on the final implementation; do not claim a speedup from
  unrelated macOS/Linux runs.
