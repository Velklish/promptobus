# PB-279 · promptobus ask writes as user, and the orchestrator owes that question an answer

- **Order:** 160
- **Scope:** [04-protocol § Message types](../../reference/04-protocol.md#message-types), [03-cli § Guard and warden](../../reference/03-cli.md#guard-and-warden), `lib/answers.js`, `lib/guard.js`, `lib/cli.js`, `lib/send.js`
- **Created:** 2026-09-26
- **Dependencies:** PB-265, PB-270
- **Cost:** major

## Context

The loop guard holds a participant's turn while it owes an answer, and `answerOwedSince` in `lib/answers.js` returns `null` for `orchestrator` by decision. The person is not an addressee at all: a question typed into the orchestrator's chat is invisible to the bus, and an orchestrator busy with its workers' questions ends its turn owing the person nothing the mechanism can see. The owner decided on 2026-09-26 (ADR-022): the person is the address `user`, asks by a command from a terminal, and a `question` from `user` is the one debt an orchestrator owes — questions from teamleads and peers create none.

## Work to do

- `promptobus ask "<text>" --task <id> [--to orchestrator | teamlead:<slug>]` writes a `question` from `user` to the addressed orchestrator of that task (a teamlead is the `orchestrator` of its child task). The `user` participant is registered on first use, per task, with no session.
- `ask` refuses when the calling process carries a harness session identity (the ADR-010 resolver) or a bus address: a participant cannot ask as the person. On a harness whose shell inherits the parent's identity the refusal names that.
- `answerOwedSince` for `orchestrator` anchors on the latest unread-or-unanswered `question` from `user` and is even after an `answer` to `user`; the guard's text names the person's question. `status` prints `UNANSWERED` for an orchestrator owing the person.
- `promptobus ask --answers --task <id>` prints the `user` mailbox and marks it read; `digest` (PB-280) prints unanswered questions first.
- 04-protocol's answer table gains the `user` row; 03-cli documents the command.

## Out of scope

- Debts for `question` from teamleads or peers: rejected by the owner.
- A model between the person and the bus: PB-281.

## Verification

- After `ask`, `promptobus guard` for the orchestrator's session exits 2 with the debt text; after `send --type answer` to `user` it exits 0; `status` shows `UNANSWERED` in between.
- `ask` run from a participant's shell (a session identity in the environment) is refused; run from a plain terminal it lands in the orchestrator mailbox as `user`.
- `ask --answers` prints the answer once and an empty box afterwards.
