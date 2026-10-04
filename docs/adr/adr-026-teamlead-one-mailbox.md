# ADR-026: A child task names its root orchestrator `root:<root slug>`

**Status:** Accepted
**Date:** 2026-10-03, rewritten 2026-10-04
**Deciders:** the owner, through the root orchestrator of a run on 2026-10-03. Where root mail to a teamlead lands, and how mail an earlier version left at the root is read, were decided again on 2026-10-04 in [ADR-028](adr-028-participant-mailbox.md), which this record no longer governs.

## Context

A teamlead is one session with two addresses ([ADR-021](adr-021-task-tree-and-governance-routes.md)): `teamlead:<slug>` in the root task and `orchestrator` of its child task. Its bus entry runs as the child's `orchestrator`. A teamlead that reports to its root from its child task needs an address there that stands for the root orchestrator, and a child journal that holds mail from the root needs a sender that is a participant of that task.

## Options

**Decision 1: who stands for the root orchestrator in a child.**
- 1A. A governance address in the child that stands for the root orchestrator. A child send to it is written into the root as the bound `teamlead:<slug>`.
- 1B. No address: the teamlead always names the root task and sends there as `teamlead:<slug>`. It works, but every upward send then depends on naming a second task.

**Decision 2: the address shape.**
- 2A. A bare `root`. Rejected: the address grammar of 0.22.0 and earlier admits only `orchestrator`, `reporter` and `user` bare. Measured with the 0.22.0 CLI on a child journal carrying such a record: `status` printed `MAILBOX UNREAD: the record address is invalid` on its line. An older MCP server or warden still runs during an upgrade.
- 2B. `root:<root slug>`, the root task's `adapter.slug` or its slugified id. The same 0.22.0 `status` printed an ordinary `root:root · unread 0` line, and its MCP `task`, `mailbox` and a warden round completed.

## Decision

1A and 2B, decided by the owner on 2026-10-03. The record carries `rootTask` and no session, so no session sends as it; the routing policy lets it talk to the child's `orchestrator` only. A send from the child's `orchestrator` to it is written into the root as `teamlead:<slug> → orchestrator`, with all seven types, while the root record and the child owner are bound to one session. The root orchestrator's mail to its teamlead stays in the root ([ADR-028](adr-028-participant-mailbox.md)), so the root journal holds both directions of that pair.

## Consequences

- `root` is a governance role. A host step named `root` and a worker slug starting with `root-` are refused, as `teamlead` and `peer` already are.
- `spawn --teamlead` writes the child's `root:<root slug>` record after the child link.
- Child journals written while this record also routed root mail into the child keep that mail as `root:<root slug> → orchestrator` with the root id as `originTask`; it is read in place, and the digest pairs it across the two journals.
- [04-protocol § Addresses](../reference/04-protocol.md#addresses) holds the routing rows and the record's rules.
