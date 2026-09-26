# PB-271 · promptobus link pairs two root tasks as peers; unlinked tasks cannot write to each other

- **Order:** 80
- **Scope:** [03-cli](../../reference/03-cli.md), [04-protocol § Addresses](../../reference/04-protocol.md#addresses), `lib/cli.js`, `lib/store.js`, a link module
- **Created:** 2026-09-26
- **Dependencies:** PB-265, PB-270
- **Cost:** major

## Context

Two top orchestrators run two independent root tasks, each lifted by the person in its own session, and neither is a participant of the other's task. The owner decided on 2026-09-26 that they may ask each other questions and exchange status, never hand over work (ADR-021). [ADR-011](../../adr/adr-011-a-session-address-is-per-task.md) already refused an address that can merely be named: a sender that can be chosen can be borrowed. So a peer is registered, on both sides, by an explicit command, and bound to the other task's owner session.

## Work to do

- `promptobus link <task-a> <task-b>` registers `peer:<slug-of-b>` in task A bound to B's owner session and `peer:<slug-of-a>` in task B bound to A's; the caller must be the owner of one of the two tasks by the owner gate of [ADR-017](../../adr/adr-017-the-owner-gate-is-a-positive-proof.md). Only root tasks link; a child task is refused.
- `promptobus unlink <task-a> <task-b>` removes both records; mail already in the journal stays.
- Routing admits `orchestrator` ↔ `peer:<slug>` for `question`, `answer`, `status`, `artifact` (PB-270); the warden knocks the peer's owner session as it knocks any participant.
- `status` prints peers with the task they stand for; reference § Link documents both commands.

## Out of scope

- Handing a task to a peer: `task`, `result` and `review` on the peer route stay refused.
- Linking child tasks or three tasks at once.

## Verification

- Before `link`, `send` from task A's orchestrator to anything in task B is refused; after it, `question` to `peer:<slug>` lands in B's orchestrator mailbox with sender `peer:<slug-of-a>`; `task` on the same route is refused.
- `link` from a session that owns neither task is refused by the owner gate; `link` naming a child task is refused.
- After `unlink` the send is refused again, and the earlier messages remain in both journals.
