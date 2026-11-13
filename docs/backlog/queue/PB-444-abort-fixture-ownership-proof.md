# PB-444 · Prove bounded owned cleanup across early fixture failure and abort

- **Order:** 700
- **Scope:** [Contributing](../../guides/contributing.md), [Live smoke fixtures and Host](../../reference/02-host.md), [CLI reference](../../reference/03-cli.md)
- **Created:** 2026-11-13
- **Dependencies:** none
- **Cost:** major

## Context

This packet retains four failure mechanisms: a lost exit before READY, discovery failure after detached spawn but before abort registration, canary parent-only signal forwarding, and Cursor confirmed cleanup versus intentional UNKNOWN retention. PB-340.2's historical first-await explanation is obsolete in current memoized/awaited cleanup; pending Stop intentionally retains the live record and stand. PB-390.2 never established the identity of an original surviving child. Fake-only regressions must preserve these distinctions.

This batch was approved in the 2026-11-13 whole-backlog audit at source `51867619447b812a2a03fc80fa5b271490e5756c`. Its original findings remain open until execution and acceptance. Grouping is not evidence that a hypothesis is confirmed or a defect is fixed.

## Work to do

- PB-419.31: create one exit promise immediately after spawn, before awaiting READY, and reuse it in both paths. Preserve stderr and existing SIGTERM/SIGHUP verdicts; cover exit 17 and error before READY with bounded diagnostics.
- PB-390.2: in a controlled fake-only discovery-failure probe, retain the exact owned child PID/birth identity before the failing operation, measure child death, and keep an unrelated child as a survival control. Only if a leak is demonstrated, register direct owned-child cleanup before discovery can throw.
- PB-340.3: use a no-model fake installed-tree canary child to distinguish parent-only abort from process-group signal delivery. Prove forwarding and awaited owned termination, or retain an honest UNKNOWN result and its evidence; avoid duplicate cleanup on group signals.
- PB-340.2: add bounded fake-only coverage for the named `live-cursor` and `live-mixed` cleanup routes. Confirmed exact owned native Stop removes only its record; pending/unresolved Stop retains the pane, record, home and sandbox, including through scoped sweep.
- Keep common boundaries in `scripts/live-abort.mjs` and `scripts/live-run.mjs` and the named canary/cursor/mixed entrypoints only. Preserve existing installed-tree, environment, home and cleanup verdicts, normal abort cases and foreign/no-abort controls.

## Acceptance criteria

- PB-419.31: an exit/error before READY produces a bounded failure with stderr rather than a lost pending promise; normal SIGTERM and SIGHUP verdicts remain.
- PB-390.2: controlled failure retains the owned PID/birth receipt before discovery, measures its death, preserves the foreign child and releases fixture processes within bounds. Any cleanup fix is justified by the probe; the original unmeasured survivor remains UNKNOWN.
- PB-340.3: parent-only abort reaches bounded cleanup of the actual owned fake child or a truthful UNKNOWN retention result. Group signals cause no duplicate cleanup; foreign sessions/processes remain untouched.
- PB-340.2: exact confirmed owned Stop drops only the owned registry record; abort cleanup is awaited. Bounded cleanup failure is diagnosed rather than counted as successful cleanup. Pending Stop retains pane/record/home/sandbox and scoped sweep holds them.
- No unconditional registry deletion, global process-name/prefix cleanup or source-inspection-as-live-proof substitutes for lifecycle evidence. No real provider or model quota is used by regressions.
- Existing installed-tree/environment/home/cleanup verdicts, stderr, normal signals, no-abort and foreign controls remain independently covered.

## Out of scope

- Real provider/model/native actor runs or quota consumption for regression.
- Global cleanup by process name/prefix, foreign session cleanup or deletion of unresolved native records/stands.
- Reasserting PB-340.2's obsolete first-await cause as a current defect or claiming the original PB-390.2 child survived without retained identity.
- Unrelated lifecycle implementation beyond named fixture/helper and canary/cursor/mixed entrypoints.

## Verification

- After implementation, run `npm run build`, `node test/live-abort.test.mjs`, `node test/live-run.test.mjs` and `node test/live-mixed-timeout-retention.test.mjs` from the repository root; notRun.
- Run the added fake-only canary parent-only/group-signal and Cursor confirmed/pending-Stop regressions; select the existing entrypoint test seams at implementation time and retain exact commands, owned PID/birth/session receipts, death/retention observations and exit codes; notRun.
- For actual changed mechanisms, retain focused negative controls, separately authorized semantic mutation witnesses and configured final-gate receipts; notRun. These checks do not run real provider/native actors and do not establish live qualification.

## Original findings and retained requirements

### PB-419.31 — Capture fixture exit before waiting for READY

[Complete original finding](../deferred/PB-419.31-capture-fixture-exit-before-waiting-for-ready.md).

- Create one exit promise immediately after spawn, before awaiting READY, and reuse it in both paths. Preserve stderr and existing verdicts.
- A fixture that exits before READY must produce bounded diagnostic failure; include exit 17/error-before-READY coverage. Normal SIGTERM and SIGHUP retain their verdicts. The injected helper probe is not an observed actual runner failure.
- Run `npm run build` and `node test/live-abort.test.mjs` after implementation; notRun.

### PB-340.2 — An aborted Cursor live run leaves its session registry record

[Complete original finding](../minor/PB-340.2-aborted-cursor-run-leaves-registry-record.md).

- Retain the historical unmeasured first-await claim as history; current live-cursor/mixed cleanup is memoized/awaited and must be evaluated on its current confirmed-versus-pending contract.
- Fake-only abort coverage must prove exact owned native Stop and registry removal after confirmation while preserving foreign records. Await abort cleanup and diagnose bounded failure without labeling it successful cleanup.
- Pending/UNKNOWN Stop intentionally retains the live pane, registry record, home and sandbox; scoped sweep must hold them. Never implement unconditional deletion as the fix.
- No end-to-end real Cursor stand or live claim is established by the fake-only regression.

### PB-340.3 — The package live canary has no abort cleanup

[Complete original finding](../minor/PB-340.3-live-canary-no-abort-cleanup.md).

- Use a no-model fake installed-tree child to test canary parent-only abort, including signal forwarding and awaited termination, independently from process-group signals.
- Parent-only abort must produce bounded cleanup of the actual owned child or honest UNKNOWN with retention. Group signal must not cause duplicate cleanup; foreign sessions/processes remain untouched.
- Preserve installed-tree, environment, home and cleanup verdicts and no-abort controls. Ordinary normal-tail finally execution does not prove signal cleanup; no real provider/quota is used in regression.

### PB-390.2 — Verify child cleanup when abort fixture process discovery fails

[Complete original finding](../minor/PB-390.2-abort-fixture-early-cleanup.md).

- Run a controlled fake-only fault probe that captures its exact child PID/birth identity before injecting discovery failure prior to abort-hook registration, and measures owned-child death.
- If and only if the probe demonstrates a leak, register direct owned-child cleanup before the operation that can fail and retain the regression. The original restricted run's surviving-child identity remains UNKNOWN.
- Do not infer or clean original processes by global name or prefix. Include a foreign-child survival control and bounded release of fixture processes.

## Next step

Execute this bounded batch in queue order, preserving the separate decision or evidence prerequisites above. Native/account probes retain their own explicit boundaries; queue placement itself grants none.

## Triage disposition, 2026-11-13

The owner requested completion of the remaining triage. This is a scoped queued task with work and verification defined above. Decision/investigation steps precede any dependent implementation; unmeasured claims and explicit authority boundaries remain unchanged.

## Ordinary member records

PB-419.31 remain open in deferred while this batch owns their execution. After their criteria are accepted, close each ordinary record with its own preserved task/result; `archive --into` is reserved for minor entries. Do not close any member merely because the batch was scheduled.
