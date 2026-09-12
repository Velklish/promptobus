# PB-179 · A session cannot write to a participant of another task: its own address is nailed by its MCP config, and there is no `send` command

- **Order:** 150
- **Scope:** `lib/spawn.js` (`participantMcp`, the `env` of the bus record), the MCP server's
  address resolution, `bin/` (a command), [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-12
- **Dependencies:** `PB-178` (same root: who a session is)

## Context

Found 2026-09-12 by a worker that raised two measurement participants in a task of its own and
then could not talk to them.

**A session's bus address comes from the `env` block of its MCP config, not from its
environment and not from its binding.** Measured: the worker's `workers/phase4.mcp.json` carries
`PROMPTOBUS_ROLE=worker:phase4` and `PROMPTOBUS_TASK=…`, while the session's own environment has
neither (`env | grep -c '^PROMPTOBUS_ROLE\|^PROMPTOBUS_TASK'` → 0). The workspace's root
`.mcp.json` carries only `PROMPTOBUS_HOME`, so a session started against it gets the default
role and resolves the task.

The consequence, hit in practice rather than reasoned about:

```
promptobus_send {to: "worker:zamer-cursor", task: "<the worker's own task>"}
→ error: worker-phase4 → worker-zamer-cursor: workers and workers do not write to each other
```

The `task` argument moves the task; it does not move the sender. And there is no `send` in the
CLI to route around it — `promptobus help` lists spawn, review, models, status, done, dismiss,
history, prune, guard, warden, mcp.

**So the worker did by hand what the warden does**: `tmux -L cursor-agent load-buffer` →
`paste-buffer -p` → a 1.5 s pause → `send-keys Enter` → `capture-pane` to confirm. The channel
is the documented Cursor one; what is missing is a door in the mechanism to use it.

**This is the same break as an orchestrator outside Claude Code, seen from the other end.**
There, a session cannot be an orchestrator because it has no identity; here, a session cannot be
an orchestrator of a *second* task because its address is fixed by the config that started it.
Both reduce to: who a session is, is decided once, by whoever wrote its MCP record.

## Work to do

- Decide whether a session may hold more than one role — one per task — and if so where that
  lives, given the address is carried by the MCP record today.
- Give the mechanism a door to deliver a message to a participant without being that
  participant's orchestrator in the same breath, or state that it will not have one and say why.
- A `send` on the CLI is the cheap half of this and would have unblocked the case that produced
  the card; it does not answer the identity half.

## Out of scope

- The "workers do not write to each other" rule. It is correct: context and artifacts go through
  the orchestrator, and the refusal named the reason properly.
- The Cursor wake channel itself, which worked exactly as documented.

## Verification

- A session that raised its own task can drive that task's participants without hand-driving a
  terminal multiplexer.
- The rule that workers do not write to each other still refuses when it should.

## The first implementation was built and withdrawn from the release, 2026-09-12

`promptobus send` was written in the release run, reviewed four times, and taken out of the
release by a stopping rule the orchestrator had stated before the third round: another finding
of the same class in the fourth round withdraws the command. Four majors landed on it, all of
one class — **the command grants more rights than it promises**:

1. a silent fallback to the orchestrator address for any participant;
2. the declared role taken on faith — borrowing another task's orchestrator, self-registering an
   invented address;
3. the fallback on an ownerless task, where ownership cannot be proved by construction;
4. **the ownership check is negative, not positive.** `foreignSession` returns `null` both when
   the session matches and when the participant record carries no session binding at all, after
   which the write is allowed. Reproduced by the branch's own test: an unbound `worker:one` is
   created without a session, the owner session exports `PROMPTOBUS_ROLE=worker:one` and writes
   in its name.

**What is withdrawn and what is kept.** The subcommand is not registered — dispatcher, help,
`SUBCOMMANDS` and the reference § Send all say so (`promptobus send …` answers
`unknown command "send"`). The code, its 21 checks and the reasoning stay in the branch, and the
tests keep the argv shape the removed dispatcher parsed, so a re-registration measures the same
cases without rewriting them. **ADR-011 remains the decision** — a session's address is per task
— with a section naming why its first implementation did not ship.

**The missing link, named so the next pass does not rediscover it:** the store keeps no
POSITIVE binding of a participant address to a session, so "this process is that participant"
cannot be answered affirmatively today. `foreignSession` answers only "nobody else holds it",
which is a different statement. Start there: `lib/send.js`, `test/send.test.mjs` and
ADR-011 § The first implementation, in the branch of this run.
