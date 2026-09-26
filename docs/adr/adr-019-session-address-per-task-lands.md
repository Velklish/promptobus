# ADR-019: A session's address is per task, and a positive session binding is the barrier

**Status:** Proposed
**Date:** 2026-09-26
**Deciders:** the owner, in the planning dialogue of 2026-09-26. The text is drafted by the planning session and is not yet reviewed by the owner; the status turns Accepted when PB-265 lands.

## Context

[ADR-011](adr-011-a-session-address-is-per-task.md) decided that a session's bus address is a property of the pair (session, task) and recorded why its first implementation was withdrawn: `promptobus send` granted more than it promised in four review rounds, and the fourth finding named the reason — `foreignSessionOf` in `src/protocol.ts` answers `null` for a matching session and for a record bound to no session alike, so "this process is that participant" could only be answered negatively. The command, its 21 checks and the reasoning stayed in the tree; the dispatcher does not register it.

The owner's structure of 2026-09-26 makes the case unavoidable: a teamlead is one session that is `orchestrator` of its own task and `teamlead:<slug>` of its parent task ([ADR-021](adr-021-task-tree-and-governance-routes.md)). Without a per-task address there is no teamlead.

## Options

**Decision 1 — how a process proves its address.**
- 1A. A positive binding: every lift and every owner claim records the session on the participant, and a sender is the participant of the named task whose recorded session matches the caller's identity from the driver resolver of [ADR-010](adr-010-session-identity-is-a-driver-member.md) or the record pointer of [ADR-014](adr-014-mcp-session-proof.md). An unbound record can be read and cannot send.
- 1B. `--from` with an existence check. Rejected in ADR-011 and again here: any process that reads the journal can name any address in it.
- 1C. One address per process, and no teamlead. Rejected: it refuses the owner's structure rather than implementing it.

**Decision 2 — what `PROMPTOBUS_ROLE` becomes.**
- 2A. A declared hint that must agree with the record for the named task; disagreement is a refusal that names both.
- 2B. The identity, as today. Rejected: it is what nailed a session to one address.

## Decision

1A and 2A. The barrier ADR-011 named is built before the door is opened, and the door — `promptobus send` — is registered only on that barrier. The fail-open answer of `foreignSessionOf` for an unbound record stays legal for reading and becomes a refusal for sending.

## Consequences

- A teamlead, a peer and the person's `user` address become expressible; [ADR-021](adr-021-task-tree-and-governance-routes.md) and [ADR-022](adr-022-user-addressee-and-orchestrator-debt.md) rest on this.
- A participant whose harness gives its MCP child no identity cannot send until the identity card for Cursor and Codex lands; the refusal names the reason rather than guessing.
- ADR-011 receives an amendment section when PB-265 lands, naming the barrier that closed it.
