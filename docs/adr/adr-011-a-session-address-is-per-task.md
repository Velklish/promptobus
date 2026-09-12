# ADR-011: A session's bus address becomes per-task; the CLI door built for it was withdrawn before release

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

**2. Nothing of it ships in this release.** A CLI door was built for it — `promptobus send`,
writing from the address the process can prove it has, refusing rather than guessing — and was
**withdrawn before release** after four review rounds. The section below records why and what
is missing. `promptobus send` is not a command: the dispatch answers `unknown command`.

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

## The first implementation did not reach release

**The decision above stands. Its first implementation was withdrawn before release**, on
2026-09-12, after four review rounds produced four major findings of one class — the command
granting more rights than it promised:

1. a silent fallback to the orchestrator address, which covered every participant, because a
   participant's session environment carries no bus identity on purpose;
2. a declared `PROMPTOBUS_ROLE` taken on trust, which borrowed a foreign task's orchestrator
   and let an invented worker address register itself into one;
3. the same fallback on a task with no owner, where ownership cannot be proved by construction;
4. an ownership check that was NEGATIVE rather than positive: `foreignSession` answers `null`
   both when the session matches and when the participant record carries no session at all, so
   a declared role for an unbound participant passed.

**What stays unproven is the fourth one's subject, and it is the reason to stop rather than
patch again:** the store records no POSITIVE binding of a participant address to a session, so
"this process is that participant" cannot be answered affirmatively today — only "no one else
is known to hold it", which is not the same claim. Every round fixed exactly what was named and
the defect turned out to be one layer below; four such rounds on one surface are evidence about
the surface, not about the reviews.

The code, its tests and this analysis stay in the tree, and `promptobus send` is not registered
as a command. The next attempt begins from them.

## Consequences

- **The case that produced the card is NOT unblocked.** A session that raised its own task
  still has no command for its participants, and the hand-driven terminal multiplexer stays
  the only way until the next attempt lands. That is the cost of withdrawing, and it is the
  cost the owner accepted rather than shipping a surface that grants more than it promises.
- **The rule the next attempt inherits: a session speaks as an address it can PROVE.** Ownership
  of a task is such a proof and is recorded. Membership of a participant address is NOT — and
  that gap is the whole of what stopped this one.
- When the per-task address lands, the door gains the ability to choose among the addresses the
  session legitimately holds — which is a different thing from choosing any address, and is
  the distinction this decision exists to keep.
