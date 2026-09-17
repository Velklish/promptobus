# PB-231 · dismiss and stop refuse the approver of the task while sweep admits it: the cleanup recipe cannot be executed by the role it names

- **Scope:** `lib/dismiss.js`, `lib/stop.js` (the owner gate), `lib/sweep.js` (`requireSweeper`, `approverHere` — the positive proof to reuse), `test/promptobus-dismiss.test.mjs`, `test/promptobus-stop.test.mjs`, `test/promptobus-owner-gate.test.mjs`, [03-cli](../../reference/03-cli.md) § The owner gate
- **Created:** 2026-09-17, consumer run
- **Dependencies:** none
- **Taken:** 2026-09-17

## Context

The approver role was introduced to execute the acceptance of one piece: merge, gates on the merged tree, archive, and cleanup of the piece's participants. Cleanup is three commands, and the package admits the approver to only one of them.

`sweep` proves the caller positively: the task mailbox owner, or an approver of this task holding its own recorded session (`requireSweeper` → `approverHere` in `lib/sweep.js`). `dismiss` and `stop` prove only the owner (`ownership(home, id, ORCHESTRATOR, sessionIdentity())` in `lib/dismiss.js` and `lib/stop.js`). Measured live on 2026-09-16 by two approvers in a row, refusal text verbatim:

```
✖ task run-0916-t20260916-130945 is bound to session 23bd066e-…, this one is 9c5af3b8-…:
  a participant is dismissed by the task mailbox owner. … claim the mailbox first: mailbox {claim: true}
```

The route the refusal offers is wrong for this caller: `claim` would take the mailbox away from a live orchestrator in the middle of a run. Both approvers did the right thing — reported the refusal and left the worktree and branch alone — and the orchestrator did the cleanup by hand: three `dismiss`, three `stop`, a worktree remove and a branch delete per piece. The reason `dismiss` and `stop` give for the owner-only gate — "reports about them go to that owner" — holds for a stranger and does not hold for an approver: the approver is a participant of the same task, its session is on record, and the piece it cleans up is the one it was lifted for.

## Work to do

- Admit an approver of this task holding its own recorded session to `dismiss` and `stop`, by the same positive proof `sweep` uses; do not weaken the gate for anyone else. A stranger and a session with no identity are still refused with the same text.
- Make the refusal to an approver-shaped caller say why it was refused when it is: an approver record without a session, or a session that is not the one on record.
- Say in [03-cli](../../reference/03-cli.md) § The owner gate that the three cleanup commands now share one proof, and name it.

## Out of scope

- Letting an approver `done` a task: closing the run is the owner's.
- The consumer's recipe text: the consumer rewrites its acceptance recipe against whatever this card decides.

## Verification

- A test lifts an approver record with a session and calls `dismiss` and `stop` under that session's identity: both succeed on the piece's worker and reviewer.
- The same calls under a foreign session and under no identity are refused with the owner-gate text; a mutation probe that drops the approver branch turns the first test red.
- `npm test`, `backslop lint`, `npm run audit`, `npm run pins` green.
