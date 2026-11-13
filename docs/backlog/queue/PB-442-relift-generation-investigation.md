# PB-442 · Investigate generation health and old-session reconnect after relift

- **Order:** 680
- **Scope:** [CLI reference](../../reference/03-cli.md), [Host reference](../../reference/02-host.md)
- **Created:** 2026-11-13
- **Dependencies:** none
- **Cost:** minor

## Context

PB-331.1 and PB-331.2 began as unmeasured source hypotheses at 3d048891. The current generation and service-pointer checks have changed part of the original conditions. Preserve two deterministic investigations rather than treating their historical descriptions as established live bugs. PB-409 remains the separate downstream whole-run pause/state/timer/continuation task and may use these results.

This batch was approved in the 2026-11-13 whole-backlog audit at source `51867619447b812a2a03fc80fa5b271490e5756c`. Its original findings remain open until execution and acceptance. Grouping is not evidence that a hypothesis is confirmed or a defect is fixed.

## Work to do

- PB-331.1: build a deterministic relift fixture with distinct old/new generation identities; observe the child orchestrator health before the new session's first knock and compare it with the accepted generation.
- PB-331.2: separately control an unreadable Claude session list, an old live session's MCP reconnect and the new session's first handshake; establish which generation can bind the address under current fences.
- For each hypothesis, retain the recorded event order, identities, evidence and a confirmed, rejected or UNKNOWN disposition. Apply a minimal correction only when justified; otherwise retain the measured no-change or unresolved outcome.
- Preserve self-wake, rejected handshake cases, fail-closed ownership and valid relift behavior. Keep native Stop proof and owner authority separate from reconnect/health observations.

## Acceptance criteria

- Each member has its own controlled experiment and disposition; historical static inspection is not restated as a measured current defect.
- PB-331.1: health before the first knock is tied to the accepted generation rather than an inherited old verdict; existing self-wake and rejected-handshake behavior remain covered.
- PB-331.2: an old session cannot capture the new generation; fail-closed ownership and valid relift under verified conditions remain covered. An unresolved prerequisite is reported explicitly rather than counted as a pass.
- Old/new identities and generation fences are explicit; no authority expansion or replacement of native Stop proof occurs.
- PB-409 remains open and independent, with no transfer of its pause, state-file, timer or continuation-brief acceptance to this batch.

## Out of scope

- PB-409 whole-run pause/continuation implementation or merging its scope into this batch.
- Speculative fixes, historical live replay or asserting a live defect from source inspection.
- New ownership grants, identity substitution or replacing native Stop with registry/health inference.

## Verification

- Run the two deterministic generation fixtures, recording exact commands, source/runtime identity, controlled event order, outcomes and exit codes; notRun.
- After any implementation change, run `npm run build` and the applicable existing relift/handshake focused files, recording the selected exact commands; notRun. Select these files against the current implementation rather than inventing a historical command.

## Original findings and retained requirements

### PB-331.1 — A relifted teamlead's child orchestrator line keeps the old health verdict until the first knock

[Complete original finding](../minor/PB-331.1-relifted-teamlead-child-health-line.md).

- Independently investigate the child orchestrator's stale health verdict before the first knock after teamlead relift, using explicit old/new generation identities and controlled event order.
- Record confirmed, rejected or UNKNOWN with evidence; the original source reading at 3d048891 was not rerun or live measured by its orchestrator.
- If demonstrated, ensure child health represents the accepted generation; preserve self-wake and rejected-handshake behavior.

### PB-331.2 — An old live Claude session reconnecting its MCP after a relift can bind the address when the session list is unreadable

[Complete original finding](../minor/PB-331.2-old-session-binds-after-relift.md).

- Independently investigate an old live Claude session reconnecting MCP after relift while the session list is unreadable, including the first new-session handshake and current service/pointer generation fences.
- Record confirmed, rejected or UNKNOWN with evidence; the historical source hypothesis is not current live proof.
- The old session must not capture the new generation. Preserve fail-closed ownership and valid relift under verified conditions without widening authority or substituting for native Stop.

## Next step

Execute this bounded batch in queue order, preserving the separate decision or evidence prerequisites above. Native/account probes retain their own explicit boundaries; queue placement itself grants none.

## Triage disposition, 2026-11-13

The owner requested completion of the remaining triage. This is a scoped queued task with work and verification defined above. Decision/investigation steps precede any dependent implementation; unmeasured claims and explicit authority boundaries remain unchanged.
