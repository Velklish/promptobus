# PB-437 · Remove a dead capture check and correct historical Codex pointers

- **Order:** 630
- **Scope:** [CLI reference](../../reference/03-cli.md), [Drivers reference](../../reference/05-drivers.md)
- **Created:** 2026-11-13
- **Dependencies:** none
- **Cost:** minor

## Context

The capture reader filters generated files to JSON and immediately checks the opposite condition, leaving an unreachable branch. Separately, the 0.164.0/0.165.0 fixture READMEs describe a current or local consumed contract that is no longer stored there. The parent README is the current-contract guide; historical evidence remains historical.

This batch was approved in the 2026-11-13 whole-backlog audit at source `51867619447b812a2a03fc80fa5b271490e5756c`. Its original findings remain open until execution and acceptance. Grouping is not evidence that a hypothesis is confirmed or a defect is fixed.

## Work to do

- Remove only the unreachable extension branch in `scripts/codex-schema-contract.mjs`. Keep the JSON filter, provenance exceptions, symlink rejection, schema validation and reference checks.
- Point the 0.164.0 current-contract link to the parent README. Explain that the 0.165.0 consumed contract is in Git history and the local directory retains its README and dated capture provenance.
- Add documentation guards for both stale pointers/inventories and preserve focused acceptance/rejection fixtures.

## Acceptance criteria

- PB-419.2: the unreachable branch is gone and the accepted and rejected capture sets are unchanged.
- PB-419.17: both historical READMEs match the actual local files and identify the parent as the current-contract guide; historical outcomes and inventories are preserved and no capture is relabeled.
- JSON filtering, provenance exceptions, symlink rejection, schema validation and reference checks remain covered.

## Out of scope

- Capture regeneration, changes to capture acceptance or an automatic proven-version update.
- Installed Codex invocation without authorization, native qualification or relabeling dated live evidence.

## Verification

- After implementation, run `npm run build`, `node test/codex-schema-gate.test.mjs` and `node test/codex-schema-contract.test.mjs` from the repository root; notRun.
- After implementation, run `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs` from the repository root; notRun.
- Additional audit-proposed check: `npm run codex-schema`; notRun. Run it only when the installed binary invocation is separately authorized.

## Original findings and retained requirements

### PB-419.2 — Remove unreachable capture extension check

[Complete original finding](../minor/PB-419.2-remove-unreachable-capture-extension-check.md).

- Remove only the unreachable branch; keep the JSON filter, provenance exceptions, symlink rejection, schema validation and reference checks.
- The accepted and rejected capture set must be unchanged; the unreachable check must be gone.
- Run `npm run build`, `node test/codex-schema-gate.test.mjs`, `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs`; notRun. Additional `npm run codex-schema` remains conditional on authorization for its installed binary invocation.

### PB-419.17 — Correct historical Codex capture README pointers

[Complete original finding](../minor/PB-419.17-correct-historical-codex-capture-readme-pointers.md).

- Point the 0.164.0 current-contract link to the parent. Explain that the 0.165.0 consumed contract is in Git history while the local directory retains dated evidence. Preserve historical outcomes and inventories.
- Both READMEs must match actual local files and identify the parent as the current-contract guide; no historical capture is relabeled.
- Run `npm run build`, `node test/codex-schema-contract.test.mjs`, `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs`; notRun.

## Next step

Execute this bounded batch in queue order, preserving the separate decision or evidence prerequisites above. Native/account probes retain their own explicit boundaries; queue placement itself grants none.

## Triage disposition, 2026-11-13

The owner requested completion of the remaining triage. This is a scoped queued task with work and verification defined above. Decision/investigation steps precede any dependent implementation; unmeasured claims and explicit authority boundaries remain unchanged.
