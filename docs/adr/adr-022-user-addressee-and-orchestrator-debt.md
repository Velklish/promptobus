# ADR-022: The person is an addressee, and the orchestrator owes them an answer

**Status:** Accepted
**Date:** 2026-09-26
**Deciders:** the owner, in the planning dialogue of 2026-09-26.

## Context

The loop guard holds a participant that owes an answer; `answerOwedSince` in `lib/answers.js` exempts `orchestrator` by decision. The person is not an address: a question typed into the orchestrator's chat is invisible to the bus. The owner's report: an orchestrator busy answering its workers forgets to answer the person. The merged measurement of PB-243 adds the load side: 26% of an orchestrator's carried context was mail delivery, 398 of 512 mailbox reads were `status` messages that expect no answer.

## Options

- A. A summary without a model: a command over the journal prints who does what, open questions, unanswered debts, pieces by step.
- B. The person's question as a bus message with a debt: the address `user`, a terminal command `ask`, and an orchestrator that owes an answer to that one sender.
- C. A read-only reporter session that answers from the journal and asks on the person's behalf.
- D. A secretary in the chain that receives every `status` and forwards what matters. Rejected: a node that decides what to forward, and a new bottleneck.

**The debt's reach.** The orchestrator owes an answer to `question` from `user` only; questions from teamleads and peers create no debt — the owner chose the narrow form.

**How the person asks.** From a terminal, by command; the answer lands in the `user` mailbox and is printed by the digest and by the command. `--to teamlead:<slug>` selects that teamlead's child task and asks its orchestrator. The CLI command refuses inside a session that carries a harness identity or bus address. A proven reporter session alone has a restricted MCP ask tool for its root task.

## Decision

A, B and C together; D rejected. The reporter is a governance participant, `reporter`, one per root task, read-only, sending nothing as itself; its one write is the reporter-only MCP `promptobus_ask`, which speaks as `user` and reads later answers. The same proven reporter binding admits read-only `promptobus_digest` and `promptobus_status`. No other participant identity can use these reporter-only tools.

## Consequences

- `ANSWER_EXPECTED` keeps its table; the orchestrator's exemption gains exactly one exception, and `status` prints `UNANSWERED` for an orchestrator owing the person.
- A digest can be read without spending a model turn; a reporter costs a session and is optional.
- On a harness whose shell inherits the parent's identity, or whose MCP child proves its session through a record, the terminal `ask` command from inside a participant is refused by construction and named in the refusal. The reporter's separate MCP tool requires proof of its own reporter binding.
- A session orchestrating several tasks keeps the user question's debt in the task where it landed, even after that mailbox is read; its bound turn stays held until it answers in that task.
