# PB-448 · Design one launch lifecycle module for workers and reviewers

- **Order:** 730
- **Scope:** [Spawn and review](../../reference/03-cli.md), [Drivers](../../reference/05-drivers.md)
- **Created:** 2026-11-16
- **Dependencies:** none
- **Kind:** architectural design exploration
- **Design:** proposal only; interface and implementation have not been approved

## Context

Worker and reviewer launch code repeat the protocol connecting participant generation, service grant, participant record and live reservation. Each caller copies `launchId`, finalizes the service launch, writes launch files, invokes `reservedSpawn`, selects persistence by harness and decides which reservation can safely be released after failure. Common helpers do not yet hide that ordering from their callers.

The proposal is one managed participant launch module over the existing mechanisms. Worker code keeps worktree/brief preparation. Reviewer code keeps review evidence, read ceilings and distinct `pending` semantics. The shared module would own generation/grant/record/live-reservation coordination, publication, persistence and cleanup justified by observed launch state.

Origin: architecture review of Promptobus 0.33.0, 2026-11-16, candidate 02, rated a strong opportunity but not selected or designed with the owner. Source at review and registration: `9dfdbddd66840bc5c0596cc6753fc44323a86b72`. Static inspection identified duplicated caller knowledge. It did not demonstrate a broken launch, cleanup defect, test success or measured speed/token savings. This card preserves the proposal without making it an approved design or depending on the temporary HTML report.

### Evidence and reading map

Line ranges refer to that source commit. Re-resolve by symbol on the design/implementation tree.

| Source | Existing responsibility |
|---|---|
| `lib/spawn.ts:1928–1968, 2027–2121`, worker launch | Reservation and participant record, generation transfer, service finalization, files, spawn, harness persistence and cleanup. |
| `lib/review.ts:893–933, 999–1062`, reviewer launch | Parallel orchestration with role-specific grant resources, pending state, persistence and cleanup. |
| `lib/live-reservation.ts:186–223` | Existing live-seat owner distinguishes `starting`, `bound` and confirmed `stopped`; do not replace it. |
| `lib/service-launch.ts:180–285`, especially `198–212, 223–260` | Grant preparation, revocation, beforeStart and realization. |
| `lib/driver-common.ts:10–28` | Preserves both original and cleanup errors; consolidation must retain both. |
| `test/live-cap-entrypoints.test.mjs`, `test/live-reservation.test.mjs`, `test/live-reservation-driver.test.mjs` | Cross-role/harness reservation and entrypoint fixtures, inspected but not run for the review. |

### Boundaries to preserve

- Keep [ADR-040](../../adr/adr-040-shared-workspace-service.md) and [ADR-012](../../adr/adr-012-stopping-one-participant-is-a-verb-of-its-own.md). Preflight stays before native launch. Driver-owned Stop and retirement do not move to the caller.
- Reuse the driver interface and its Claude, Cursor, Codex and OpenCode adapters. Test through existing scripted harness binaries rather than adding an abstract lifecycle port.
- An attempted native launch with unknown outcome must remain discoverable for recovery. There is no blanket rollback or unconditional reservation release after an exception.
- Reviewer grant resources can be required before finalization. Preserve that publication order rather than forcing it to match worker order.
- Worker/reviewer pending meanings, sessionRecord retention and successful/dead launch persistence remain role-correct. Existing errors and recovery instructions remain observable.
- Host, cwd, env, task and address retain their ownership and isolation. Do not create process-global launch state or derive authority from arbitrary caller data.
- PB-406.6 — Enforce live participant caps through one reservation lifecycle is already implemented. This proposal reduces caller knowledge above it; it does not reimplement caps or fix an absent reservation lifecycle.

## Work to do

1. Map worker/reviewer stages and ownership on the current source, including every publication and failure boundary. Separate role-specific preparation from shared generation/grant/reservation invariants.
2. Propose the narrow internal interface and show the caller branches it removes. Fit role-specific preparation without recreating the whole protocol as mandatory callbacks.
3. Resolve the open design questions below with the owner. Record the accepted boundary and any architectural decision through the repository procedure before proposing implementation.
4. Produce the implementation plan and scenario-to-assertion matrix below. A design-only completion does not require source changes or invent test results.

## Acceptance criteria for this design task

- A design artifact in the repository names the owner of generation, grant, participant record and live reservation at every stage, including failures.
- The proposed interface demonstrates removal of manual `launchId` transfer, repeated harness persistence branches and duplicated cleanup from both callers.
- Role-specific worktree/brief/evidence/read-grant preparation remains explicit without exporting shared ordering as callbacks.
- Unknown native launch, confirmed no-launch and confirmed stopped have distinct outcomes. Original and cleanup errors are retained together.
- The design reuses live reservation, managed service launch and driver mechanisms. It preserves the different reviewer pending/read-resource rules.
- The owner accepts the responsibility boundary. The artifact records acceptance or unresolved questions honestly; it does not claim implementation acceptance.
- A bounded implementation plan names source changes, documentation, failure-injection witnesses and gates. Create or refine implementation work only after that decision and its mandate.

## Requirements retained for future implementation

These are acceptance constraints for a later authorized implementation, not work authorized by this design card.

- Both worker and reviewer use the shared launch interface over `live-reservation`, `service-launch`, `reservedSpawn` and existing drivers. Two new functions that leave the protocol in both callers do not pass.
- Existing cross-harness/role live-cap, reservation and driver checks remain. Dry-run/preflight refusals still stop before native launch and consume no live seat.
- Controlled failures before/after grant preparation, launch-file publication and native start show when grants/reservations are released and when unknown state is retained.
- Reviewer pre-finalization grant files, read ceilings, pending state and relift/recovery behavior stay correct. Worker worktree/dependency/generator/brief behavior stays unchanged.
- A fixture observes both original and cleanup errors when both occur. No exception path invents confirmed Stop or discards recovery identity.
- Public exports, command behavior and driver Stop ownership do not change. Reference, subsystem documentation and CHANGELOG change in the implementation pass, not as a premature claim during design.

## Out of scope

- Implementing the module before design and implementation approval.
- Teamlead's one-session/two-address lifecycle, task links and mailbox aliases. They overlap this area but stay outside the first worker/reviewer pass.
- New reservation/cap/driver/service-grant frameworks, unified role policies or transactional rollback.
- MCP request admission, receipts/replay or BB-owned environment transitions.

## Verification

- For the design result, compare the stage/failure map against both caller implementations and the existing helpers. Retain source/function references and an explicit deletion test: which caller knowledge disappears, not merely which file becomes shorter.
- Planned implementation commands, notRun at registration: `npm run build`; `node test/live-cap-entrypoints.test.mjs`; `node test/live-reservation.test.mjs`; `node test/live-reservation-driver.test.mjs`; `node test/shared-service-managed-launch.test.mjs`.
- Plan a role × harness × failure-stage matrix naming observed generation, grant, record, reservation and native-start state. Preserve entrypoint coverage beside helper tests.
- After future committed test changes, use `npm run probe` to establish that ordering/cleanup assertions fail when their rules are removed. Preserve unknown-launch retention rather than weakening it to simplify cleanup assertions.
- Run configured gates for the design change and, separately, for future implementation with its own `--base`. Keep exact commands/counts/exit codes. Static architecture review supplied no executed gate evidence.
- Native/account-backed or stress runs require separate authorization. Scripted harness results do not establish live behavior.

## Open design questions and next step

- Owner, before implementation: what minimal launch input/result hides ordering without making callers provide persistence and cleanup choreography?
- Owner, before implementation: where does role preparation end when reviewer grant resources must exist before service finalization?
- Owner, before implementation: which retained outcome represents each unknown launch and cleanup failure without introducing a new recovery contract?

Next step: execute this design exploration in queue order, then agree the interface and failure-state map. Schedule consolidation only after that checkpoint and an implementation mandate. The authenticated MCP request module is not a dependency; registering either card does not authorize its implementation.
