# PB-402 · Plan progress and review dispatch while the orchestrator is busy

- **Order:** 280
- **Scope:** [Orchestration](../../../skills/orchestrate/SKILL.md), [Host](../../reference/02-host.md)
- **Created:** 2026-10-26
- **Dependencies:** none
- **Cost:** —

## Context

During the 2026-10-26 local acceptance run, the owner observed that ready work and independent reviews waited for the busy orchestrator. The owner requested a future design for this bottleneck. The orchestrator currently mediates handovers, review dispatch, live resources and serial integration by model turns.

Evidence: retained canonical worker status at 13:24:30 UTC stated that full gates had not started after focused checks on a frozen revision, with no running operation or technical blocker. Other results waited while the orchestrator prepared runtime and UI checks. This is evidence from one run, not a controlled model-capacity comparison or a measured token-saving claim.

Investigate the existing pipeline, role handover, command receipts and warden before proposing another dispatcher. The actual owner and canonical mailbox remain authoritative; a notification is neither task content nor permission.

## Work to do

- Identify where approved ready work can enter independent review without waiting for another orchestrator model turn, using the existing lifecycle and routing contracts.
- Define observable phase states from actual command/session start and terminal receipts. Detect idle work without a handover or explicit blocker within a stated interval.
- Keep complete source/evidence identity through review, concrete corrections and acceptance. Preserve owner decisions, model/permission policy, role separation and concurrency limits.
- Deliver bounded actionable summaries to the orchestrator while retaining original streams. Notification delivery must not imply processing or mailbox acknowledgement.
- Delegate isolated execution and live-demo resources explicitly. Keep integration into each repository main sequential. Do not add another coordinator model by default.
- Produce a concrete design, dependency map and bounded verification plan for owner approval before implementation. Separate this dispatch problem from routine BB child-completion activation covered by [PB-374](../active/PB-374-bb-child-outcome-wake-budget.md).

## Out of scope

- Implementation during the current acceptance run, a new orchestration framework, private BB APIs, global settings, model substitution or wider permissions.
- Reclassifying historical failures, losing messages/receipts or inferring per-role token savings from shared account usage.

## Verification

- A deterministic replay includes ready results, concrete findings/corrections, duplicates, a busy owner, an idle worker and stopped grants. Assert dispatch latency, model-start counts, preserved messages and maximum concurrency.
- A bounded live proposal defines baseline and candidate source/runtime identities, actual phase receipts and serial integration evidence.
- The design states which existing component owns dispatch, gate start, summary delivery and resource leases, and lists unsupported public API boundaries explicitly.
- Planning is complete only after the owner accepts the design and implementation scope; this card does not assert the bottleneck is fixed.
