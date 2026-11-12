# PB-400 · Show native work and wake its BB owner through the plugin

- **Scope:** [Host integrations](../../reference/02-host.md), optional native BB plugin only
- **Created:** 2026-10-26
- **Dependencies:** none
- **Cost:** —

## Context

The owner approved a visual task dashboard and notifications from native participants to their ordinary BB orchestrator, so the person can manage that thread from a phone. The installed observer is a JSON view and does not wake an idle BB owner. All implementation belongs to the optional plugin; the core, CLI and native drivers remain unchanged.

## Work to do

- Render task selection, participants, canonical status/questions/results, recorded activity and explicit stale/error states. Keep JSON in optional diagnostics.
- Read inbox and history without consumption, ACK or journal mutation.
- Bind the selected task owner to a real Codex BB thread through its recorded provider identity. Opt in explicitly and baseline existing messages.
- Deliver new actionable messages through public BB send, persist delivery state and avoid duplicate sends across polling/reload. Retain ambiguous delivery as unresolved rather than replaying it.
- Keep the orchestrator as an ordinary BB thread and native lifecycle in Promptobus. Document setup, limits and observed live behavior.

## Out of scope

- Changes to Promptobus core, CLI, drivers or native lifecycle; surrogate worker threads, bidirectional transcript mirroring, permission overrides and release/main integration.

## Verification

- Focused plugin tests cover selected task identity, unread message visibility, owner binding, duplicate prevention, reload and ambiguous delivery.
- Demonstrate the actual installed UI and an idle BB test owner receiving a canonical notification; verify the mailbox remains unread and reload does not replay it.
- Run plugin typecheck/tests/build and appropriate repository checks, then independent review and closure. Keep commands/exits and any failed observations.

## Transfer to main

Recovered on 2026-11-13 from `acceptance-ru46-rest-reserved-ids` at `0dcf219ef5ad7c7ef73e079a26a4bf686f8c5090`. This transfers the recorded finding only. Historical verification and approval apply to the named source and run; no implementation, current reproduction or acceptance is implied. Next step: compare the finding with current source and accepted work, then prioritize or merge an established duplicate. Previous active status is not carried into this metadata transfer.
