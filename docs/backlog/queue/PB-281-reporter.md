# PB-281 · promptobus report lifts a read-only reporter that answers from the journal and asks on the person's behalf

- **Order:** 180
- **Scope:** [03-cli](../../reference/03-cli.md), `lib/review.js` or a lift module, `lib/driver-claude.js`, the lift texts
- **Created:** 2026-09-26
- **Dependencies:** PB-266, PB-270, PB-279, PB-280
- **Cost:** major

## Context

The owner decided on 2026-09-26 (ADR-022) to take, beside the digest and the command, a session the person can talk to: it reads the journals of the whole tree and `status`, answers in words in its own window, and when the journal does not answer, asks the orchestrator on the person's behalf. It is a bus participant with a fixed governance role, `reporter`, one per root task, read-only, and it never sends as itself (PB-270): its only write is `promptobus ask`, which speaks as `user`.

## Work to do

- `promptobus report --task <root> [routing flags] [--dry-run]` lifts `reporter` on Claude Code at the install root; Cursor and Codex are refused with the ADR-015 reason. The role's deny list is the reviewer's plus the bus send tool; its MCP entry carries the root task.
- The lift text: answer from the journal and the digest; when the answer is not there, run `ask` and bring the answer back; never paraphrase a result as accepted; name the message it answers from.
- `status` prints the reporter under the root; `done` of the root stops it with the other managed sessions.

## Out of scope

- A reporter that forwards or filters status for the orchestrator: the owner rejected a secretary in the chain.
- Reporters on child tasks.

## Verification

- `reporter` cannot send: a `promptobus_send` from its session is refused by the deny list and, if reached, by routing.
- A question in the reporter's window that the journal does not answer appears in the orchestrator's mailbox from `user`, and the answer appears in the reporter's window.
- `report` on a child task is refused; `report --dry-run` prints the plan and starts nothing.
