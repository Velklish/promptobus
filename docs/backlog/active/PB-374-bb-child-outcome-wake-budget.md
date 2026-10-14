# PB-374 · Avoid coordinator model turns for routine BB child-turn completion

- **Scope:** [BB host adapter](../../reference/02-host.md)
- **Created:** 2026-10-13
- **Dependencies:** none
- **Cost:** —
- **Taken:** 2026-10-13

## Context

The owner requested a smaller orchestration overhead after a BB backlog run on 2026-10-13. The run retained 19 managed threads and 185 completed turn pairs; the coordinator started 83 turns. Its official BB log contained 80 `child-completed` turn requests, 13 `child-needs-attention`, and additional explicit messages. Request counts are not turn counts: several requests can join one turn.

Evidence: [anonymized run measurements](../../evidence/bb-orchestration-2026-10-13.json), produced with `bb thread log thr_ygz2mn78mx --json --all`, exit 0. `bb-plugin-promptobus/runtime.ts` assigns participant `parentThreadId` and `lifecycleOwnerThreadId`; the exact avoidable fraction and a supported suppression route have not been measured. This is a performance hypothesis, not a claim that all 83 turns were unnecessary.

[PB-319](../../archive/LOG.md#pb-319) covers bus `status` notifications. This entry covers BB system child-outcome activation, including turns that send no actionable bus result.

## Work to do

- Replay retained child-outcome and bus events, classifying which events require a coordinator decision and which only update visible progress.
- Use the public BB SDK lifecycle to avoid a coordinator model turn for routine child completion when no new actionable message exists. If the SDK cannot express this, record the supported boundary and the smallest required public API change; do not use private app internals.
- Keep questions, final results, failures, approval attention and stop conditions visible and actionable. Preserve mailbox messages, ordering and acknowledged delivery.
- Coalesce duplicate outcomes. Completion of a child must not reactivate a stopped or terminal parent grant. Preserve lifecycle ownership, predecessor validation and the global active-session limit.
- Update the BB adapter and orchestration references with measured turn counts before and after.

## Out of scope

- Native harness driver rewrites, global BB settings, permission widening or model-quality changes.
- Claiming a per-thread token saving from shared account usage.

## Verification

- A deterministic replay containing routine completion events makes zero coordinator model calls when no decision is pending; one final result wakes it and includes the retained messages.
- Questions, failures and approval attention are delivered; duplicate events do not repeat a decision or start another worker.
- A stopped parent remains stopped when an old child finishes; a fresh grant is required for later work.
- Record replay input, model-start count, message count, exits and exact candidate SHA. A bounded live check confirms the chosen official lifecycle route before source review.
