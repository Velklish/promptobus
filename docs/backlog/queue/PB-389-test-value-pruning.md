# PB-389 · Remove redundant assertions and replace tests disconnected from production

- **Order:** 360
- **Scope:** [Contributing](../../guides/contributing.md), test value and preserved behavior
- **Created:** 2026-10-20
- **Dependencies:** none
- **Cost:** major

## Context

The recovery audit found redundant predicates and tests whose local oracle does not exercise the promised production behavior. Inventory at `5386bd5d6dedd84dd69760cfee4f1c0f19543f87`: 157 root test files, 8,319 assertion-shaped AST sites and 1,112 test registrations. These are static counts, not executed tests or evidence that all files were semantically audited.

Concrete low-risk candidates: `documentation-contract.test.mjs` repeats six individual booleans through `every(Boolean)`, duplicates ADR index inventory already covered by `adr-consolidation.test.mjs`, and freezes one historical prose phrase. Stronger replacement candidates: `promptobus-copy.test.mjs` quoting predicate accepts an identity implementation; credential priority and driver registry checks assert source spelling rather than behavior. Import-boundary scanners need equivalence checks before merging.

The BB `command-grants.test.mjs` helper executes an independent local state machine. An isolated diagnostic preserved its decisions after adding instructions that directly contradicted STOP/release. This establishes a local-model coverage limitation, not a runtime permission defect. Preserve real engine/runtime checks and useful canonical-text/parity checks.

Priority: after correctness and autonomy blockers. Expected impact: less false confidence and duplicated maintenance; execution-time and token savings are notMeasured.

## Work to do

- Remove only demonstrated duplicate or non-contractual assertions, with a mapping to surviving guarantees.
- Replace weak quoting, registry and credential-selection predicates with behavioral checks before dropping their old coverage. Keep a security check until an adequate replacement exists.
- Replace the independent command-grant toy model with useful canonical instruction invariants and production runtime/engine cases. Literal test-state preservation is not evidence of production patch preservation.
- Merge import scanners or repeated package setup only after equivalence and setup-cost measurements. Use one immutable artifact per source within a run; preserve isolated installed consumers.
- Coordinate deletion of the duplicate private-source predicate in the consumer with its public-import boundary tests. This does not authorize deleting other consumer coverage.

## Out of scope

- Mass deletion based on file size, test count, provider name or absence of a provider subscription.
- Removing lifecycle, permission, ownership, recovery or legacy compatibility guarantees without an explicit product decision.
- Broad runner optimization, a new test framework, or promised percentages of speedup.

## Verification

- Record removed verdict names and the remaining behavioral guarantee for each deletion; retain exact failures from semantic mutation checks.
- The quoting identity mutation must fail a named behavior assertion. Driver miswiring, wrong credential priority and broken import boundaries must be detected by their replacements.
- STOP/release/ownership tests must invoke production functions where they claim runtime behavior. Text tests must be described as text contracts.
- Run focused changed suites and the required repository mutation probe on a clean committed tree; distinguish assertion failure from build failure or timeout.
- Measure setup and selected-file counts separately from actual runtime and provider usage. Do not infer whole-suite savings from a small predicate deletion.
