# ADR-026: A teamlead has one mailbox, its child task's

**Status:** Accepted
**Date:** 2026-10-03
**Deciders:** the owner, through the root orchestrator of a run on 2026-10-03.

## Context

A teamlead is one session with two addresses ([ADR-021](adr-021-task-tree-and-governance-routes.md)): `teamlead:<slug>` in the root task and `orchestrator` of its child task. Its bus entry runs as the child's `orchestrator`, so its mailbox tool reads the child's mailbox and nothing else. A root send to `teamlead:<slug>` landed in the root task at `inbox/teamlead-<slug>/`, which nothing a Claude Code teamlead holds reads or marks.

On a test stand at 0.23.0 two root sends to `teamlead:group-one` stayed in the root slot. The teamlead's `promptobus_mailbox` answered `empty` on its child task and `FOREIGN MAILBOX` with `task: <root>`; after both reads the slot still held two unread, and the root warden knocked the teamlead with `has unread: 2` at once, again past the 120-second retry threshold, and again after the teamlead's own read. The root orchestrator of a live tree reported, on the same day, 26 and 24 unread at two such slots and one teamlead knocked seven times in 17 minutes; it moved the files to `history/` by hand.

A message in a task journal is sent by a participant of that task, and a child task had no participant that stands for the root.

## Options

**Decision 1 — where root mail to a teamlead lands.**
- 1A. In the child's `orchestrator` mailbox, the one the teamlead reads.
- 1B. A second readable address in the root for the teamlead's session. Rejected by the owner: two mailboxes for one session, and every guard, warden and tool would have to know both.

**Decision 2 — who sends it in the child journal.**
- 2A. A new governance address in the child that stands for the root orchestrator. A root send is written into the child from it, with the root id as `originTask`, as a peer send is written into the other root; a child send to it is written into the root as the bound `teamlead:<slug>`.
- 2B. Keep the message in the root journal and put its inbox reference into the child's mailbox. No new address, but every reader of a child mailbox, history and postcard would have to learn that a message there may belong to another task, and the v1 fan-out and its recovery would change.

**Decision 3 — the address shape.**
- 3A. A bare `root`. Rejected: the address grammar of 0.22.0 and earlier admits only `orchestrator`, `reporter` and `user` bare. Measured with the 0.22.0 CLI on a child journal carrying such a record: `status` printed `MAILBOX UNREAD: the record address is invalid` on its line. An older MCP server or warden still runs during an upgrade.
- 3B. `root:<root slug>`, the root task's `adapter.slug` or its slugified id. The same 0.22.0 `status` printed an ordinary `root:root · unread 0` line, and its MCP `task`, `mailbox` and a warden round completed.

**Decision 4 — mail already unread at the root slot.**
- 4A. Move it on the teamlead's next read of its child mailbox: re-deliver each root-orchestrator message into the child under a new id, then move the root reference to root history.
- 4B. Leave it and name it in `status`. Rejected: the teamlead stays knocked until someone moves files by hand.

## Decision

1A, 2A, 3B and 4A, decided by the owner on 2026-10-03. All seven message types pass both ways between the root orchestrator and its teamlead, as on any vertical route. Root mail to a teamlead whose child task is closed stays in the root task. Sibling traffic between teamleads stays in the root task and is not changed by this decision.

## Consequences

- `root` joins the governance roles. A host step named `root` and a worker slug starting with `root-` are refused, as `teamlead` and `peer` already are.
- The root journal no longer holds what the root sends its teamleads; the child journal does. The digest pairs a question in one journal with its answer in the other.
- The drain re-delivers before it marks read, so an interruption between the two leaves a duplicate rather than a loss. A message whose artifact record does not read, or whose file is gone from the root's files folder, stays unread at the root slot and is named; a drain that fails on the slot itself leaves the read of the child mailbox intact and is retried on the next read.
- A Codex teamlead keeps its root MCP entry: it proves `teamlead:<slug>` for upward sends and reads sibling mail, which still lands in the root slot.
- [04-protocol § Addresses](../reference/04-protocol.md#addresses) holds the routing rows and the record's rules; [03-cli § Spawn](../reference/03-cli.md#spawn) holds the drain.
