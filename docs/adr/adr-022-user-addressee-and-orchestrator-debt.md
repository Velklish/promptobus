# ADR-022: The person is an addressee, and the orchestrator owes them an answer

**Status:** Proposed
**Date:** 2026-09-26
**Deciders:** the owner, in the planning dialogue of 2026-09-26. The text is drafted by the planning session and is not yet reviewed by the owner; the status turns Accepted when PB-279, PB-280 and PB-281 land.

## Context

The loop guard holds a participant that owes an answer; `answerOwedSince` in `lib/answers.js` exempts `orchestrator` by decision. The person is not an address: a question typed into the orchestrator's chat is invisible to the bus. The owner's report: an orchestrator busy answering its workers forgets to answer the person. The merged measurement of PB-243 adds the load side: 26% of an orchestrator's carried context was mail delivery, 398 of 512 mailbox reads were `status` messages that expect no answer.

## Options

- A. A summary without a model: a command over the journal prints who does what, open questions, unanswered debts, pieces by step.
- B. The person's question as a bus message with a debt: the address `user`, a terminal command `ask`, and an orchestrator that owes an answer to that one sender.
- C. A read-only reporter session that answers from the journal and asks on the person's behalf.
- D. A secretary in the chain that receives every `status` and forwards what matters. Rejected: a node that decides what to forward, and a new bottleneck.

**The debt's reach.** The orchestrator owes an answer to `question` from `user` only; questions from teamleads and peers create no debt — the owner chose the narrow form.

**How the person asks.** From a terminal, by command; the answer lands in the `user` mailbox and is printed by the digest and by the command. The command refuses inside a session that carries a harness identity, so a participant cannot ask as the person.

## Decision

A, B and C together; D rejected. The reporter is a governance participant, `reporter`, one per root task, read-only, sending nothing as itself; its one write is `ask`, which speaks as `user`.

## Consequences

- `ANSWER_EXPECTED` keeps its table; the orchestrator's exemption gains exactly one exception, and `status` prints `UNANSWERED` for an orchestrator owing the person.
- A digest can be read without spending a model turn; a reporter costs a session and is optional.
- On a harness whose shell inherits the parent's identity, `ask` from inside a participant is refused by construction and named in the refusal.
