# PB-176 · `STALLED: permission prompt` is printed for a classifier denial too, and the route it names leads nowhere

- **Order:** 120
- **Scope:** `lib/status.js` (the stall line), `lib/driver-claude.js` (how a session's state is
  read), [03-cli](../../reference/03-cli.md) § Status, done, dismiss, history, prune
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

Measured 2026-09-12 on a live worker of a run. `promptobus status` printed:

```
session "Worker: …" STALLED: permission prompt — only a person can answer:
claude attach 352b5f94 (or drop the session: claude stop 352b5f94)
```

The orchestrator read the line, told the owner a person was needed, and named the command. **No
dialogue existed.** The worker reported its own state, with the evidence:

> Диалога, который можно снять «да»/«нет», нет и не было; ни одна моя команда не висит. Что
> есть: auto-mode classifier молча отбивает отдельные вызовы Bash, возвращая сразу отказ.

Four Bash calls of that run were refused, each with the same text —
`Permission for this action was denied by the Claude Code auto mode classifier. Reason: Blocked
by classifier.` — and the session kept working the whole time: `npm test`, `audit`, the gates and
four commits all went through. Three of the four refusals the worker routed around honestly, by
reading through other tools.

**Two different states, one label, and the routes are opposite.** A hanging dialogue is cleared
by a person attaching to the session. A classifier refusal cannot be: there is nothing to attach
to, the call already returned, and what is needed is a permission rule — a decision taken outside
the session, by the person who owns it. Printing the first route for the second sends the reader
to an empty terminal, and the orchestrator repeats it upward as fact.

## Work to do

- Separate the two states in the line, or stop claiming which one it is. The honest minimum is
  to say what was observed — the session is not producing output and has not ended its turn —
  and to name both routes rather than the wrong one.
- Where a classifier refusal is distinguishable from a hanging dialogue, name it as such and
  route it to the person who can add the rule, not to `claude attach`.
- The same line is quoted by the orchestration skill; it moves with the change.

## Out of scope

- The classifier's decisions. What it refuses is not this package's business; how the refusal is
  reported is.
- The other stall reasons (`session limit`, a reason in the participant's own words) — they are
  correct today.

## Verification

- A session refused by the classifier is not reported as waiting for a person at a prompt.
- A session genuinely waiting at a prompt still names `claude attach`.
