# PB-449 · Design a BB participant transition module for Stop resume and archive

- **Order:** 740
- **Scope:** [Drivers and BB integration](../../reference/05-drivers.md), [BB plugin](../../../integrations/bb/README.md), [Protocol](../../reference/04-protocol.md)
- **Created:** 2026-11-16
- **Dependencies:** none
- **Kind:** architectural design exploration
- **Design:** proposal only; interface and implementation have not been approved

## Context

BB CLI handlers manually compose delivery pause, epoch capture, transition serialization, SDK Stop/observation, child-notification policy and resume compensation. Their action-specific decisions are mixed with ordering needed to ensure that a late response cannot undo a newer Stop.

The proposal is to deepen the concrete BB lifecycle/delivery module. Callers express separate intentions: Stop, ordinary resume, a fresh bounded phase or archive. The module hides shared transition ordering and compensation while reusing BB SDK and durable SQLite adapters. It must not combine BB participants and native drivers into one lifecycle abstraction: their environment owners and Stop evidence differ.

Origin: architecture review of Promptobus 0.33.0, 2026-11-16, candidate 03, rated worth exploring but not selected or designed with the owner. Source at review and registration: `9dfdbddd66840bc5c0596cc6753fc44323a86b72`. The review inspected source/tests, not executed transitions, real BB Stop or gate results. It identified caller complexity, not a demonstrated Stop failure or proof that the proposal is safe. This card retains the proposal without depending on the temporary HTML report.

### Evidence and reading map

Line ranges belong to that source commit. Re-resolve by symbol before design/implementation.

| Source | Existing responsibility |
|---|---|
| `integrations/bb/runtime.ts:127–172`, `withParticipantTransition`, `syncChildNotifications`, `stopWithChildNotifications`, `resumeDelivery` | Local transition queue, SDK child-identity checks, fresh observation and resume compensation. |
| `integrations/bb/runtime.ts:735–802`, registered `participant stop` and `participant resume` | Pause before waiting, captured epoch checks, fresh-phase transfer and ordinary resume branches. |
| `integrations/bb/runtime.ts:813–848`, registered `participant archive` | Separate child/Stop checks, workspace preservation, archive confirmation and `accepted: false`. |
| `integrations/bb/delivery.ts`, `integrations/bb/lifecycle.ts` | Durable delivery state and concrete BB lifecycle mechanisms to reuse. |
| `integrations/bb/test/engine.test.mjs:1127–1271, 1512–1537, 2368–2475` | Registered-command transition/race witnesses, inspected but not run for the review. |
| `integrations/bb/test/lifecycle.test.mjs` | Existing BB lifecycle observations and Stop behavior. |

### Contracts to preserve

- Keep [ADR-030](../../adr/adr-030-bb-authoritative-participants.md), [ADR-031](../../adr/adr-031-bb-environment-lifecycle.md), [ADR-032](../../adr/adr-032-bb-wake-recovery.md) and [ADR-037](../../adr/adr-037-bb-current-control-authority.md): canonical journal, BB-owned environments, durable pause and current-control admission stay authoritative.
- Stop sets durable pause before waiting or joining the per-participant transition queue. Capture and recheck the relevant epoch so a newer Stop wins over ordinary resume and fresh-phase transfer.
- SDK replies alone are not physical all-calls Stop proof. Preserve existing fresh observation/confirmation requirements, queued/background checks and refusal when proof is unavailable.
- Child-notification updates validate exact child/thread/project/provider/parent/lifecycle-owner binding and resulting policy. Partial failure cannot silently resume delivery.
- Failed notification restore re-pauses and performs existing compensation. A late queued reply or reload cannot cancel a persisted newer pause.
- Current control stays mandatory. A fresh phase requires full assignment, fresh token and bounded phase, plus reviewer evidence where applicable. An ended token cannot be revived.
- Stop/resume, fresh grant transfer and archive/preservation stay different actions. Archive retains child checks, fresh Stop evidence, unchanged workspace checks and `accepted: false`; it is not task acceptance.

## Work to do

1. Map registered Stop, resume, fresh-phase and archive branches, including durable writes, epochs, SDK waits, child notifications and compensation.
2. Propose a concrete internal transition interface. Identify which handler ordering disappears and which action-specific policy stays outside. Avoid generic native/BB lifecycle unification.
3. Resolve the design questions below with the owner. Record the accepted responsibility boundary and any architectural decision through the repository procedure.
4. Produce a bounded implementation plan and registered-interface scenario matrix. Keep design delivery separate from implementation and live qualification.

## Acceptance criteria for this design task

- A design artifact in the repository separates action intent from pause/epoch/serialization/notification/compensation ordering.
- Its responsibility/state-transition map identifies each wait that can race with a newer Stop, reload or child-notification failure.
- The proposed interface removes manual protocol composition from handlers, not merely relocates private helpers.
- Archive/preservation and fresh-grant decisions retain their different policies. Native driver lifecycle and BB lifecycle stay separate.
- The owner accepts the boundary before source changes. The artifact records acceptance or unresolved questions honestly and does not invent a solution for unavailable physical Stop proof.
- The implementation plan names command-level regression witnesses, affected files/documentation and checks. New implementation work requires its own mandate.

## Requirements retained for future implementation

These constrain a later authorized implementation, not source work authorized by this design card.

- Registered handlers no longer assemble shared transition ordering. Command schemas, responses, exit codes and action-specific branches stay compatible.
- A controlled Stop during resume/fresh-phase transfer persists pause before waits and wins over late replies. No ended grant becomes usable again.
- Serialization stays participant-scoped. The transition uses the same binding and current control, not a replacement actor or environment.
- Restart/reload retains durable pause and epoch. Recovery cannot wake a paused participant merely because an earlier request completed later.
- Partial notification failure retains pause and exposes existing compensation results. Identity mismatch refuses rather than updating another child.
- Ordinary resume, pending initial assignment and fresh-phase assignment retain different validation/delivery behavior and reviewer evidence checks.
- Archive retains separate child, Stop, preservation and final observation checks. Insufficient evidence neither disposes of the environment nor reports task acceptance.
- Existing SDK/SQLite adapters and refusal behavior remain. No capability or authority is broadened.
- Registered CLI/dispatch tests remain the verification surface. Private-helper tests cannot replace them. Update BB README, lifecycle/delivery documentation, reference and CHANGELOG in the implementation pass.

## Out of scope

- Implementation before design/implementation approval, or a real Stop experiment during design work.
- Solving physical all-calls Stop proof or claiming a recovery route BB does not supply.
- Changing current-control admission, durable store schemas, ended-token rules, canonical journal ownership or BB environment ownership.
- Combining native/BB lifecycle, replacing SDK/SQLite adapters or merging Stop/resume/archive meanings.
- New grant policy, mailbox delivery features, BB compatibility release or live qualification.
- Closing PB-373.2 — BB errored participant cannot confirm Stop for a fresh phase, or PB-373.13 — Preserve observed command termination across BB Stop signals. Their Stop evidence/termination work stays separate; this structural refactor is not their implementation.

## Verification

- For the design result, compare the state/ordering map against registered handlers and delivery/lifecycle/store implementations. Retain symbol references and identify removed caller obligations explicitly.
- Planned implementation commands, notRun at registration: `npm run build`; `npm --prefix integrations/bb run check`; `npm --prefix integrations/bb test`. The integration test command compiles `.test-build` and runs the test files, including engine/lifecycle tests.
- Plan a registered-command matrix for Stop during resume, late queued reply, reload, child identity mismatch and partial notification failure. Name held boundary, persisted pause/epoch, SDK events, final delivery state and response.
- Future negative controls must fail when epoch revalidation is removed, pause moves after a wait or compensation is skipped. After committed test changes, use `npm run probe` and record its actual coverage.
- Run configured gates for the design change and, separately, for future implementation with its own `--base`. Keep BB-specific checks visible; root gates alone do not establish that the integration commands above ran.
- Installed BB behavior, physical termination and account-backed execution remain separately authorized qualification, not conclusions from mocked SDK/SQLite tests.

## Open design questions and next step

- Owner, before implementation: which concrete module owns transitions while archive/preservation and new-grant decisions retain separate policy?
- Owner, before implementation: how will fresh-phase assignment and notification compensation be represented without handlers rebuilding epoch ordering?
- Owner, before implementation: which registered-interface fixtures provide deterministic Stop/reload/late-reply barriers without widening the production API?

Next step: execute this design exploration in queue order, then agree the interface before scheduling implementation. Worker/reviewer launch consolidation and authenticated MCP request handling are independent work, not prerequisites. Queue placement grants neither a BB runtime change nor a real Stop experiment.
