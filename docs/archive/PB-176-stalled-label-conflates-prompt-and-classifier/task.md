# PB-176 · `STALLED: permission prompt` is printed for a classifier denial too, and the route it names leads nowhere

- **Order:** 120
- **Scope:** `lib/status.js` (the stall line), `lib/driver-claude.js` (how a session's state is
  read), [03-cli](../../reference/03-cli.md) § Status, done, dismiss, history, prune
- **Created:** 2026-09-12
- **Dependencies:** none

## Context

Measured 2026-09-12 on a live worker of a run. `promptobus status` printed:

```
session "Worker: Пины вне backslop.json, дубль в .gitignore… (0911-2256)"
STALLED: permission prompt — only a person can answer: claude attach 352b5f94
(or drop the session: claude stop 352b5f94)
```

The orchestrator read the line, told the owner a person was needed, and named the command.
**No dialogue existed.** The session kept working the whole time: `npm test`, `npm run audit`, the
gates and eight commits all went through it. Four of its `Bash` calls had been refused by the
harness's auto-mode classifier, each returning at once with `Permission for this action was denied
by the Claude Code auto mode classifier. Reason: Blocked by classifier.` Three of the four the
worker routed around honestly, by reading through other tools.

**The defect is the route, and it holds whatever set the mark.** `stallRoute` for
`kind: 'permission'` said `only a person can answer: claude attach <id>` and nothing checked that a
dialogue was standing. A standing prompt is cleared by a person attaching. A refusal that has
already returned cannot be: there is nothing to attach to, the call is over, and what is wanted is a
permission rule decided outside the session. Printing the first route for the second sends the
reader to an empty terminal, and the orchestrator repeats it upward as fact — which is exactly what
happened.

**What is measured about the mark itself, and what is not.** Measured: `sessionStall`
(`lib/driver-claude.js`) reaches `kind: 'permission'` only through a non-empty
`session.waitingFor`, and the printed reason is that field's own value — so the record carried
`waitingFor: "permission prompt"` at that moment. Measured: the same record carries no such field
now (`claude agents --json`, `status: busy`, `state: working`), so the mark is transient. Measured:
the value is a short label from a fixed observed set — `permission prompt`, `sandbox request`,
`input needed` — and names no cause. Measured: a held peer message (`PB-165`) is ruled out for this
session — its participant settings file holds only `enableAllProjectMcpServers`, `viewMode`,
`hooks`, `skillOverrides`, no `crossSessionInbound`, and `PB-165` measured that `auto` takes a
postcard without that key.

**Not measured: that the classifier's refusal is what set the mark.** It is an inference from the
coincidence in time, and it is written as one.

## Work to do

- Separate the two states in the line, or stop claiming which one it is. The honest minimum is
  to say what was observed — the session is not producing output and has not ended its turn —
  and to name both routes rather than the wrong one.
- Establish what does set `permission` on a session that is working — the field's own history is
  not kept, so this needs a record at the point the verdict is made, not an inference after it.
- Where a classifier refusal is distinguishable from a hanging dialogue, name it as such and
  route it to the person who can add the rule, not to `claude attach`.
- **Correction to this card as filed.** It said the orchestration skill quotes the same line and
  moves with the change. It does not: the skill defers to the printed route and names no command
  (`git grep` for `STALLED`, `permission prompt` and `attach` over `skills/` and `templates/`
  returns that one deferring line). Nothing there moves.

## Out of scope

- **Proving what set the mark by a stand.** The refusal is not reproducible on demand: the same
  command shape (`git grep … | head`) was refused at one point of the run and went through an hour
  later, so the classifier does not decide by the form of the command alone. Nothing can pair a
  refusal with a registry read, and a card requiring that pairing would be unexecutable. This is why
  the fix is in what the route claims, not in telling the two states apart.
- The classifier's decisions. What it refuses is not this package's business; how the refusal is
  reported is.
- The other stall reasons (`session limit`, a reason in the participant's own words) — they are
  correct today.

## Verification

- A session refused by the classifier is not reported as waiting for a person at a prompt.
- A session genuinely waiting at a prompt still names `claude attach`.
