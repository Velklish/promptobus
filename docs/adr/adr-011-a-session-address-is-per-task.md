# ADR-011: A session's bus address becomes per-task; the CLI door writes only from the address it already has

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
There a session cannot be an orchestrator because it has no identity ([ADR-010](adr-010-session-identity-is-a-driver-member.md));
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
process can prove it has** — `PROMPTOBUS_ROLE` when the caller declares one. It creates no new
contract and removes the hand-driven multiplexer that produced the card.

**And it REFUSES rather than falling back when it cannot prove one.** A participant's session
environment carries no bus identity on purpose (`lib/spawn.js`, `sessionEnv`: identity travels
as hook-command arguments, because a value put in the environment is inherited by neighbours
and hands out a foreign identity). So an undeclared role is not "orchestrator", it is
"unknown" — and answering it with the orchestrator's address would have been exactly the
borrowing this decision refuses `--from` to prevent, only invisible, with no flag on the
command line to see it by. The orchestrator address is taken only when the process can name
its own session AND that session owns the task; otherwise the command fails with the reason.

**3. There is no `--from`, and there will not be one before the barrier exists.** It was the
cheap way to close the same case, and it was refused: a sender that can be chosen is a sender
that can be borrowed, and the only barrier that could stop borrowing is ownership of the task,
which is ADR-010's subject and is not in place. Shipping `--from` would have been a hole
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
- **A session speaks as an address it can PROVE, and ownership is such a proof.** A worker that
  opens a task of its own is recorded as that task's owner, so `send` lets it write there as the
  orchestrator — which is the case that produced the card. What stays out of reach is speaking as
  an address it cannot prove: a participant of a task it does not belong to, an address another
  session holds, or the orchestrator of a task owned by someone else or by nobody at all. Each of
  those is a refusal naming the session that does own it.
- When the per-task address lands, `send` gains the ability to choose among the addresses the
  session legitimately holds — which is a different thing from choosing any address, and is
  the distinction this decision exists to keep.
