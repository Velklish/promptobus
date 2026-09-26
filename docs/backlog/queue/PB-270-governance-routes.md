# PB-270 · Governance routes: teamleads exchange only question, answer, status, artifact; user asks; reporter never sends

- **Order:** 70
- **Scope:** [04-protocol § Addresses](../../reference/04-protocol.md#addresses), `lib/store.js` (`routingPolicy`), `lib/answers.js`, `src/mcp/tools.ts`
- **Created:** 2026-09-26
- **Dependencies:** PB-265, PB-266, PB-267
- **Cost:** major

## Context

`routingPolicy` in `lib/store.js` knows one rule and one exception: every participant corresponds with `orchestrator`, and `worker` and `approver` of one task write to each other. The owner's tree (ADR-021, ADR-022) adds addresses whose routes are a closed table, decided on 2026-09-26:

| Sender | Recipient | Types | Decision |
|---|---|---|---|
| `orchestrator` | any participant of its task | all seven | unchanged |
| any participant | `orchestrator` of its task | all seven | unchanged |
| `teamlead:a` | `teamlead:b` of the same root task | `question`, `answer`, `status`, `artifact` | small matters stay between siblings; a change of logic or requirements goes to the root orchestrator |
| `orchestrator` | `peer:<slug>` | `question`, `answer`, `status`, `artifact` | peers ask, never assign |
| `user` | `orchestrator` | `question` | the person asks the top of the tree |
| `orchestrator` | `user` | `answer`, `status` | the answer and progress lines |
| `reporter` | nobody | none | the reporter reads |

The mechanism does not judge whether a matter is small: it restricts the type, and the teamlead's instruction (PB-272) says what "large" means. Pairs absent from the table are refused with a reason that names the vertical route.

## Work to do

- `routingPolicy` implements the table from the registry (PB-266) and reads the tree (PB-267) to know which teamleads are siblings; a route that needs a peer link (PB-271) reads the link record.
- The refusal text for a `task`, `result` or `review` between siblings names the root orchestrator as the route.
- `ANSWER_EXPECTED` is unchanged for participants; the orchestrator's exemption in `answerOwedSince` stays for every sender except `user`, which PB-279 introduces.
- 04-protocol carries the table verbatim, with the decision column.

## Out of scope

- Creating `peer:<slug>` (PB-271), `user` (PB-279) and `reporter` (PB-281): this card decides what they may do once they exist.
- The pipeline routes between steps of one task (PB-275).

## Verification

- One test per allowed row and one per refused pair from the table, including `task` from `teamlead:a` to `teamlead:b`, `question` from `teamlead:a` to a teamlead of another root task, and any send from `reporter`.
- The refusal for a sibling `task` names the root orchestrator.
- The existing worker–approver direct route and every orchestrator route pass unchanged.
