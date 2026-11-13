# PB-400 · Qualify installed native notifications to the BB owner

- **Scope:** [Host integrations](../../reference/02-host.md), optional native BB plugin only
- **Created:** 2026-10-26
- **Dependencies:** PB-429 for installed BB 0.49 qualification
- **Cost:** —

## Context

The owner approved a visual task dashboard and notifications from native participants to their ordinary BB orchestrator, so the person can manage that thread from a phone. The visual dashboard and owner-notification source were delivered through PB-397. This card retains the installed owner-notification qualification: source presence and dashboard acceptance do not prove an idle BB owner receives a canonical notification. All implementation belongs to the optional plugin; the core, CLI and native drivers remain unchanged.

## Work to do

- Use the dashboard delivered by PB-397 as the observation surface; retain its task selection, participants, canonical status/questions/results, activity and explicit stale/error states, with JSON in optional diagnostics. Qualify the residual notification flow rather than rebuilding the dashboard.
- Read inbox and history without consumption, ACK or journal mutation.
- Verify the installed selected-task owner binding to a real Codex BB thread through its recorded provider identity, explicit opt-in and baseline of existing messages.
- Qualify installed delivery of new actionable messages through public BB send, persistent delivery state and duplicate prevention across polling/reload. Retain ambiguous delivery as unresolved rather than replaying it.
- Keep the orchestrator as an ordinary BB thread and native lifecycle in Promptobus. Document setup, limits and observed live behavior.

## Out of scope

- Changes to Promptobus core, CLI, drivers or native lifecycle; surrogate worker threads, bidirectional transcript mirroring, permission overrides and release/main integration.

## Verification

- Focused plugin tests cover selected task identity, unread message visibility, owner binding, duplicate prevention, reload and ambiguous delivery.
- On a compatible installed plugin (PB-429 for BB 0.49), demonstrate an idle BB test owner receiving a canonical notification through the actual installed UI; verify the mailbox remains unread and reload does not replay it. Retain ambiguous delivery as unresolved.
- Run plugin typecheck/tests/build and appropriate repository checks, then independent review and closure. Keep commands/exits and any failed observations.

## Transfer to main

Recovered on 2026-11-13 from `acceptance-ru46-rest-reserved-ids` at `0dcf219ef5ad7c7ef73e079a26a4bf686f8c5090`. This transfers the recorded finding only. Historical verification and approval apply to the named source and run; no implementation, current reproduction or acceptance is implied. Next step: compare the finding with current source and accepted work, then prioritize or merge an established duplicate. Previous active status is not carried into this metadata transfer.

## Audit limits, 2026-11-13

Installed idle-owner wake, unread preservation, reload deduplication and ambiguous-delivery behavior were not exercised by this audit. Current plugin gates and independent qualification review are notRun; the delivered dashboard does not close this residual.

## Deferred

- **Deferred:** 2026-11-13
- **Reason:** Installed owner-notification qualification depends on a compatible installed BB plugin combination. PB-429 still owns the BB 0.49 compatibility release; delivered dashboard source does not establish idle-owner delivery on that installation.
- **Return condition:** PB-429 supplies a qualified compatible plugin combination and an explicitly authorized bounded BB owner/participant stand is available. Measure canonical notification, unread retention, reload deduplication and ambiguous-delivery handling with the original limits.
