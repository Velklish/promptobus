# ADR-010: A session's bus address becomes per-task; the CLI door writes only from the address it already has

**Status:** Accepted
**Date:** 2026-09-12
**Deciders:** Павел Ким (owner), decision of 2026-09-12 on PB-179 of the release run

## Context

A session's bus address comes from the `env` block of the MCP config that started it, and
nothing moves it afterwards. `resolveIdentity` reads it in one line:

```js
// lib/store.js
const role = of('PROMPTOBUS_ROLE', 'role') || ORCHESTRATOR;
```

The task, by contrast, IS movable: `declaredTask` is read separately and every bus tool takes
a `task` argument. That asymmetry is the whole defect. A worker that opened a task of its own
could address its participants by task and still wrote to them as `worker:<its own slug>`,
which the routing policy correctly refuses:

```
promptobus_send {to: "worker:…", task: "<the worker's own task>"}
→ error: worker-phase4 → worker-zamer-cursor: workers and workers do not write to each other
```

There was also no CLI door at all — `spawn, review, models, status, done, dismiss, history,
prune, guard, warden, mcp` — so the worker drove a terminal multiplexer by hand
(`load-buffer` → `paste-buffer` → a pause → `send-keys Enter` → `capture-pane`) to wake its
own participants. The channel was the documented one; what was missing was a door into it.

This is the same break as an orchestrator outside one harness, seen from the other end.
There a session cannot be an orchestrator because it has no identity ([ADR-009](adr-009-session-identity-is-a-driver-member.md));
here it cannot be an orchestrator of a SECOND task because its address was fixed by whoever
wrote its MCP record. Both reduce to: who a session is, is decided once, by someone else.

## Decision

**1. A session's address becomes per-task: one session may hold one address per task.** The
address stops being a property of the process and becomes a property of the pair
(session, task) — which is what the task argument already assumes. The bus rule that
participants correspond only through the orchestrator is unchanged; it is a rule about a PAIR
of addresses and stays exactly as strict.

**2. The implementation does not ship in this release.** What ships is the door and nothing
else: `promptobus send <address> --body <text>` writes one message **from the address the
process already has** — `PROMPTOBUS_ROLE`, or the orchestrator default. It creates no new
contract, it can do nothing the MCP tool could not, and it removes the hand-driven multiplexer
that produced the card. The per-task address lands after identity, because the barrier it
needs is task ownership and ownership needs a session to be identifiable first.

**3. There is no `--from`, and there will not be one before the barrier exists.** It was the
cheap way to close the same case, and it was refused: a sender that can be chosen is a sender
that can be borrowed, and the only barrier that could stop borrowing is ownership of the task,
which is ADR-009's subject and is not in place. Shipping `--from` would have been a hole
described as a feature.

## Alternatives considered

**Keep one address per process and add `--from` with a participant-exists check.** Rejected
above: an existence check is not a barrier. Any process that can read the journal can name any
address in it.

**Leave the asymmetry and document it.** Rejected because the documented workaround is a
person hand-driving tmux, which is what the card measured actually happening.

## Consequences

- The case that produced the card is unblocked now: a session that raised its own task can
  drive that task's participants with a command instead of keypresses.
- A session still cannot speak as a second address, so a worker that opens a task of its own
  still cannot act as its orchestrator. That is a named gap with a named condition, not a
  silence.
- When the per-task address lands, `send` gains the ability to choose among the addresses the
  session legitimately holds — which is a different thing from choosing any address, and is
  the distinction this decision exists to keep.
