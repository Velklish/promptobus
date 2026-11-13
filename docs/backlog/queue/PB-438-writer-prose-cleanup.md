# PB-438 · Finish the bounded prose cleanup and preserve writer ledger coverage

- **Order:** 640
- **Scope:** [Contributing: local writer rules](../../guides/contributing.md#local-writer-rules), [Documentation roadmap](../../ROADMAP.md)
- **Created:** 2026-11-13
- **Dependencies:** none
- **Cost:** minor

## Context

PB-317.2 concerns decorative emphasis on "every" and a test that pins it. PB-304.1 retains ten specific minor prose/table candidates from a historical release pass. At the audit baseline, five candidates had already changed and five style issues remained. This is a bounded, nonblocking style packet; the historical release-pass measurements are provenance, not a new writer run.

This batch was approved in the 2026-11-13 whole-backlog audit at source `51867619447b812a2a03fc80fa5b271490e5756c`. Its original findings remain open until execution and acceptance. Grouping is not evidence that a hypothesis is confirmed or a defect is fixed.

## Work to do

- Remove bold emphasis from "every shipped skill" in contributing guidance and update only the matching literal assertion in `test/release-writer.test.mjs`; preserve the requirement for a ledger row for CLI help and every shipped skill.
- Retain an explicit disposition for all ten PB-304.1 candidates: brief run-up, ADR-row instruction emphasis, CLI comparison introduction, ADR table gap and Windows boundary emphasis are already changed; stop ONE, sweep ONE, roadmap negative framing, ADR-012 dramatic bold closer and routing TWO reads remain.
- Correct only those five remaining PB-304.1 style issues without changing runtime behavior, command semantics, technical facts or dated measurements. Coordinate any overlap with routing-current-docs so prose cleanup does not restore stale current inventories.

## Acceptance criteria

- PB-317.2: the rule and its pinned assertion agree without decorative asterisks; ledger coverage still includes CLI help and every shipped skill.
- PB-304.1: all ten original candidates have an explicit already-changed/remain disposition; only the five remaining style issues are edited and already changed wording is not reintroduced.
- Facts, support boundaries and dated observations remain intact. Style findings do not become release blockers, and PB-330 currency regression work remains separate.

## Out of scope

- Runtime implementation, journal changes or broader prose rewriting.
- PB-330 currency checks or treating these minor findings as release blockers.
- Recreating five candidates already changed at the audit baseline.

## Verification

- After implementation, run `node test/release-writer.test.mjs` from the repository root; notRun.
- After implementation, run `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs` from the repository root; notRun.
- Review the ten-candidate mapping against the original PB-304.1 evidence and the resulting diff; notRun.

## Original findings and retained requirements

### PB-317.2 — contributing.md bolds «every» for emphasis, and a test pins the bold

[Complete original finding](../minor/PB-317.2-bold-every-local-rule.md).

- Remove bold emphasis from "every" in `docs/guides/contributing.md` and remove the matching asterisks from the literal assertion in `test/release-writer.test.mjs` in the same change.
- Preserve one ledger row for CLI help and one for every shipped skill; the style correction must not weaken coverage.

### PB-304.1 — Release writer retains minor prose and table findings

[Complete original finding](../minor/PB-304.1-release-writer-minor-prose-table-findings.md).

- Keep a mapping of all ten original prose/table candidates, retaining their historical provenance and nonblocking minor status.
- Already changed: README brief run-up; docs/README ADR creation instruction emphasis; CLI process-comparison introduction; docs/README ADR-036 table gap; README Windows boundary emphasis. Do not recreate these issues.
- Remaining: README stop ONE; README sweep ONE; roadmap "instead of a blind flag" framing; ADR-012 "The kill left a lie behind" dramatic bold closer; model-routing "TWO reads" emphasis. Correct only these style issues.
- Preserve technical facts and command/support boundaries. PB-317.2 remains a distinct requirement inside this batch, and PB-330 currency checks remain outside it.
- No runtime implementation, journal changes or release-blocking status is authorized by this style packet.

## Next step

Execute this bounded batch in queue order, preserving the separate decision or evidence prerequisites above. Native/account probes retain their own explicit boundaries; queue placement itself grants none.

## Triage disposition, 2026-11-13

The owner requested completion of the remaining triage. This is a scoped queued task with work and verification defined above. Decision/investigation steps precede any dependent implementation; unmeasured claims and explicit authority boundaries remain unchanged.
