# PB-435 · Align routing documentation with supported APIs and retained readings

- **Order:** 620
- **Scope:** [Drivers reference](../../reference/05-drivers.md), [CLI reference](../../reference/03-cli.md), [Model routing](../../guides/model-routing.md)
- **Created:** 2026-11-13
- **Dependencies:** none
- **Cost:** minor

## Context

The baseline audit found stale current inventories, consumer recipes that recommend an unexported internal module, an expiry paragraph that says readings disappear, and a claim that calibration is the only telemetry reader. These are four independent documentation findings. The audit counted four registered harnesses and 82 catalog tuples, 23 base rows and 13 quality hypotheses; these are baseline source inventories, not live availability measurements.

This batch was approved in the 2026-11-13 whole-backlog audit at source `51867619447b812a2a03fc80fa5b271490e5756c`. Its original findings remain open until execution and acceptance. Grouping is not evidence that a hypothesis is confirmed or a defect is fixed.

## Work to do

- PB-419.7: reconcile current harness and catalog inventories in the glossary, roadmap and routing guide with the registry and catalog at implementation time. Preserve dated three-account observations, role floors and hook limitations.
- PB-419.9: identify `loadCatalog`, `validate` and `validateLayers` as internal implementation details; direct consumers to supported `routingDiagnosis` or `runPromptobus` entry points as appropriate.
- PB-419.10: distinguish unknown availability after expiry from retained model/window readings with their original source and age; explain `windowsExpiry` as diagnostic information.
- PB-419.16: include `stats` and model counts among telemetry read paths, and describe calibration/rating proposals and confirmed application separately.
- Add an independent documentation regression for each of the four findings.

## Acceptance criteria

- Current inventories match the registry and catalog; dated observations, role floors and hook limitations remain accurate.
- Consumer recipes use exported package specifiers; internal functions remain clearly identified as implementation detail, without promising an unexported pure API.
- The guide neither claims expired readings disappear nor presents retained data as fresh telemetry. Original age/source and the unknown-availability boundary remain explicit.
- The reference includes `stats` and model counts without changing calibration's write and confirmation boundary.

## Out of scope

- New public routing APIs or package exports.
- Changes to routing support policy, role floors, hook limitations, calibration authority or automatic overlay application.
- Live model or account probing; source inventory updates do not establish live harness qualification.

## Verification

- After implementation, run `npm run build`, `node test/model-routing-preflight.test.mjs` and `npm run audit` from the repository root; notRun.
- After implementation, run `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs` from the repository root; notRun.

## Original findings and retained requirements

### PB-419.7 — Correct current harness inventories

[Complete original finding](../minor/PB-419.7-correct-current-harness-inventories.md).

- Update current inventories and verify counts against the catalog. Preserve dated measurements, role floors and hook limitations.
- Current inventories must match the registry; historical observations and role limitations remain accurate.
- The baseline inventory is four harnesses, 82 tuples, 23 base rows and 13 quality hypotheses; recheck source inventory when implementing, without relabeling dated three-account measurements.
- Run `npm run build`, `node test/docs-links.test.mjs`, `node test/docs-task-independence.test.mjs` and the additional audit-proposed `npm run audit`; notRun.

### PB-419.9 — Use supported consumer routing validation entry points

[Complete original finding](../minor/PB-419.9-use-supported-consumer-routing-validation-entry-points.md).

- Mark the routing validation functions internal and direct consumers to supported `routingDiagnosis` or `runPromptobus` routes as appropriate. Do not promise an unexported pure API.
- Consumer recipes must use supported specifiers; internal descriptions remain identifiable as implementation detail.
- Run `npm run build`, `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs`; notRun.

### PB-419.10 — Correct expired preflight retention description

[Complete original finding](../minor/PB-419.10-correct-expired-preflight-retention-description.md).

- Correct the expiry paragraph to distinguish unknown availability, retained measured windows and diagnostic `windowsExpiry`.
- The guide must not claim readings disappear or present old data as fresh telemetry; retain their original age and source.
- Run `npm run build`, `node test/model-routing-preflight.test.mjs`, `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs`; notRun.

### PB-419.16 — Correct telemetry reader description

[Complete original finding](../minor/PB-419.16-correct-telemetry-reader-description.md).

- Replace the only-reader claim with the accurate calibration and rating-proposal boundary.
- The reference must include `stats` and model counts without changing the write/confirmation boundary for calibration.
- Run `npm run build`, `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs`; notRun.

## Next step

Execute this bounded batch in queue order, preserving the separate decision or evidence prerequisites above. Native/account probes retain their own explicit boundaries; queue placement itself grants none.

## Triage disposition, 2026-11-13

The owner requested completion of the remaining triage. This is a scoped queued task with work and verification defined above. Decision/investigation steps precede any dependent implementation; unmeasured claims and explicit authority boundaries remain unchanged.
