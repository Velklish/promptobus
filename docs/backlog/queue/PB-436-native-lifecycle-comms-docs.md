# PB-436 · Clarify actionable mail and the managed tree Stop sequence

- **Order:** 710
- **Scope:** [Protocol reference](../../reference/04-protocol.md), [CLI reference](../../reference/03-cli.md), [Managed Stop decision](../../adr/adr-012-stopping-one-participant-is-a-verb-of-its-own.md)
- **Created:** 2026-11-13
- **Dependencies:** PB-416.26
- **Cost:** minor

## Context

Readable progress-only owner mail is intentionally excluded from actionable escalation, but residual reference and generic instruction wording still promises a wake or SILENT escalation for every unread message. PB-419.14's original blanket managed-root refusal was already corrected in 72d6f80f; the remaining work is explicit child-to-root Stop guidance and closure boundaries. Consumer observations in the originals remain attributed protocol evidence, not a diagnosis of transport failure or post-change verification.

This batch was approved in the 2026-11-13 whole-backlog audit at source `51867619447b812a2a03fc80fa5b271490e5756c`. Its original findings remain open until execution and acceptance. Grouping is not evidence that a hypothesis is confirmed or a defect is fixed.

## Work to do

- Correct residual blanket wake/SILENT wording in the protocol/CLI references and packaged orchestration/participant instructions. Progress uses `status`; a blocker or mandatory answer requires an actionable `question` before end-turn, an `answer` for release, and completion uses `result`.
- Describe the finite managed-tree sequence: stop the owned child teamleads first, retain their results, then request the managed root's self-Stop and have an authorized observer inspect its completion proof.
- Keep pending self-Stop acknowledgement distinct from confirmed Stop. Explain native Stop, task metadata closure and service shutdown as separate operations.
- Retain the already-correct managed-root exception, unmanaged attached-human refusal and retained-cleanup rules. Add guards against stale blanket root refusal, blanket wake promises and premature `done --keep-sessions` before Stop.
- State a supported task/service closure route only after it is verified through PB-416.26. Until then, state the established boundary and unresolved closure separately.

## Acceptance criteria

- PB-419.12: both references predict no owner SILENT escalation for readable progress-only mail and retain no-answer/no-read and other actionable escalation; unreadable inbox handling remains conservative.
- Packaged instructions require an actionable message before ending a blocking HOLD and do not promise a forced wake for status-only progress.
- PB-419.14: the ADR continues to predict permitted managed-root Stop and attached-human refusal without broader authority; previously delivered wording is preserved rather than redone.
- Instructions put child Stop before root self-Stop, distinguish pending acknowledgement from confirmation, and do not offer done-before-Stop or foreign-controller authority as a workaround.
- Existing managed-root and pending-proof checks remain, and separate documentation regressions detect stale communication and shutdown recipes.

## Out of scope

- Changes to supervisor filtering, native Stop implementation or ownership authority.
- Redoing the managed-root exception already delivered in 72d6f80f.
- Claiming transport latency or failure from message timestamps, or equating model-turn counts with MCP retry counts.
- New watcher, replacement actor, repeated HOLD/release loop, identity rewrite or replay of historical lifetimes.
- Implementing task/service closure in PB-416.26 or promising its route before verification.

## Verification

- After implementation, run `npm run build`, `node test/promptobus-warden.test.mjs`, `node test/promptobus-stop.test.mjs` and `node test/lead-lifecycle.test.mjs` from the repository root; notRun.
- After implementation, run `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs` from the repository root; notRun.

## Original findings and retained requirements

### PB-419.12 — Document owner status-only escalation exception

[Complete original finding](../minor/PB-419.12-document-owner-status-only-escalation-exception.md).

- Qualify both references with the owner status-only exception, preserving no-answer/no-read and other actionable mail behavior. Both must predict no owner SILENT for readable progress-only mail.
- Extend the correction to packaged orchestration/participant instructions: progress-only status is nonblocking; a mandatory answer or blocker needs an actionable message before end-turn; completion uses result.
- Add a regression that fails on the old blanket "mail arrives, root wakes" promise and preserves no forced wake for status-only progress. Preserve unreadable/actionable escalation.
- Keep the originals' startup-HOLD, publication relay, separate nonprogress and shutdown handoff observations attributed and distinct. Their transport causes and unmeasured retry details remain UNKNOWN; metadata reconciliation grants no execution authority.
- Run `npm run build`, `node test/promptobus-warden.test.mjs`, `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs`; notRun. Historical live protocol evidence is not post-change documentation verification.

### PB-419.14 — Document managed root Stop exception

[Complete original finding](../minor/PB-419.14-document-managed-root-stop-exception.md).

- Preserve the managed-root exception, its Stop proof/retained-cleanup rules, historical context and refusal for unmanaged attached sessions. The ADR must predict managed-root permission and attached-human refusal without widened authority; the baseline already contains this original correction.
- Complete the remaining managed-root/teamlead guidance: child Stop precedes root self-Stop and authorized proof inspection; pending acknowledgement is not confirmed Stop.
- Keep native Stop, metadata closure and service shutdown separate. Do not prescribe `done --keep-sessions` as a bypass or imply that a foreign controller gains owner rights after self-Stop.
- Document a supported task/service closure route only when verified through PB-416.26. Retain guards against blanket root refusal and premature done-before-Stop recipes.
- Run `npm run build`, `node test/promptobus-stop.test.mjs`, `node test/lead-lifecycle.test.mjs`, `node test/docs-links.test.mjs` and `node test/docs-task-independence.test.mjs`; notRun.

## Next step

Execute this bounded batch in queue order, preserving the separate decision or evidence prerequisites above. Native/account probes retain their own explicit boundaries; queue placement itself grants none.

## Triage disposition, 2026-11-13

The owner requested completion of the remaining triage. This is a scoped queued task with work and verification defined above. Decision/investigation steps precede any dependent implementation; unmeasured claims and explicit authority boundaries remain unchanged.
