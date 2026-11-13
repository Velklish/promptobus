# PB-440 · Correct Host outputs, process binding exceptions and source citations

- **Order:** 660
- **Scope:** [Host reference](../../reference/02-host.md), [Standalone Host decision](../../adr/adr-002-standalone-host-contract.md), [Hooks and trust](../../guides/hooks-and-trust.md), [Drivers reference](../../reference/05-drivers.md)
- **Created:** 2026-11-13
- **Dependencies:** none
- **Cost:** minor

## Context

This packet contains four independent documentation corrections: the HostToolBin reader inventory, process-wide native binding exceptions, observer method output shapes, and two stale source citations. The runtime Host API and observer schemas remain unchanged. The baseline scanner discovers source files dynamically and asserts five readers; that is a source-test inventory, not a guarantee inferred from a fixed driver count.

This batch was approved in the 2026-11-13 whole-backlog audit at source `51867619447b812a2a03fc80fa5b271490e5756c`. Its original findings remain open until execution and acceptance. Grouping is not evidence that a hypothesis is confirmed or a defect is fixed.

## Work to do

- PB-419.8: describe dynamic source discovery and the current five-reader assertion in Host documentation, including why a changed count requires investigation.
- PB-419.13: qualify ADR-002 and the short Host reference with first process-wide harness-home/tool-binary bindings and the explicit client-context route; preserve the passed-Host contract and agree with detailed reference exceptions.
- PB-419.4: correct `integrations/bb-native-observer/README.md` so `tasks` describes the `{tasks, truncated, scanned}` catalogue and `ownerFeed` describes owner metadata/messages; retain bounded and missing-task behavior.
- PB-337.1: rederive the semantic target of both `lib/spawn.js:726` and `lib/report.js:180` citations in hooks-and-trust and Drivers, including install-root provenance for teamlead/reporter, then replace them with verified current TypeScript function/section references.
- Give each correction an independent regression against its stale description; do not treat the Host suite as sufficient coverage for observer outputs or both citations.

## Acceptance criteria

- The HostToolBin description matches dynamic scanning and the current assertion, explains changed-count investigation and preserves coverage.
- ADR and short reference no longer promise independent native registry/binary bindings for different Hosts within one process; process exceptions and explicit client context match the detailed reference.
- Both observer output descriptions match their schemas, retain bounded/missing-task semantics and leave the API unchanged.
- Both stale citations identify the intended current source behavior after semantic/provenance verification; replacing JS with TS mechanically is insufficient.
- Four independent documentation assertions fail on the respective old text.

## Out of scope

- Runtime Host API or observer schema changes.
- Broader source citation cleanup beyond the two findings.
- Native/live qualification or treating a source-reader count as process independence proof.

## Verification

- After implementation, run `npm run build`, `node test/host.test.mjs`, `npm --prefix integrations/bb-native-observer test` and `npm test` from the repository root; notRun.
- After implementation, run `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs` from the repository root; notRun.

## Original findings and retained requirements

### PB-419.8 — Correct HostToolBin reader inventory description

[Complete original finding](../minor/PB-419.8-correct-hosttoolbin-reader-inventory-description.md).

- Describe dynamic discovery and the current five-reader assertion accurately.
- The reference must match the scanner and explain the need to investigate a changed count; coverage is preserved.
- Run `npm run build`, `node test/host.test.mjs`, `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs`; notRun.

### PB-419.13 — Qualify Host process binding independence

[Complete original finding](../minor/PB-419.13-qualify-host-process-binding-independence.md).

- Qualify the ADR and short reference with process binding exceptions and the explicit client-context route. Preserve the passed-Host contract.
- Texts must not promise independent native registry and binary bindings for different Hosts in one process; agree with detailed reference exceptions.
- Run `npm run build`, `node test/host.test.mjs`, `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs`; notRun.

### PB-419.4 — Correct observer method output descriptions

[Complete original finding](../minor/PB-419.4-correct-observer-method-output-descriptions.md).

- Correct the descriptions of tasks and ownerFeed to match their separate schemas while retaining bounded and missing-task behavior.
- Both output descriptions must match the contract; the API is unchanged.
- Run `npm run build`, `npm --prefix integrations/bb-native-observer test`, `node test/docs-links.test.mjs`, `node test/docs-task-independence.test.mjs` and the additional audit-proposed `npm test`; notRun.

### PB-337.1 — Two documents cite code by line numbers that no longer point at the cited code

[Complete original finding](../minor/PB-337.1-stale-code-line-citations.md).

- Replace both stale source line-number citations in hooks-and-trust and Drivers with verified function/section references in the current TypeScript source.
- First derive which behavior each sentence means and verify install-root provenance for teamlead/reporter. The original card did not rederive those targets; do not guess them or perform a mechanical extension swap.
- Retain an independent regression for each stale citation.

## Next step

Execute this bounded batch in queue order, preserving the separate decision or evidence prerequisites above. Native/account probes retain their own explicit boundaries; queue placement itself grants none.

## Triage disposition, 2026-11-13

The owner requested completion of the remaining triage. This is a scoped queued task with work and verification defined above. Decision/investigation steps precede any dependent implementation; unmeasured claims and explicit authority boundaries remain unchanged.
