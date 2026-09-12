# PB-206 · Acceptance is a role the glossary names and the bus cannot address

- **Order:** 50
- **Scope:** `src/protocol.ts` (`ADDRESS_RE`, refusal texts, `participantFileStem`), `src/mcp/render.ts`, `lib/store.js` (`routingPolicy`, `participantRecord`), `lib/liftoff.js`, `lib/model-routing/*` (four role lists, `qualityFloor`), `schemas/model-routing/*`, `src/host.ts` (`participantDenyTools`), `src/mcp/tools.ts` (a further contract copy of the addresses, found 2026-09-12 while verifying the map), `docs/reference/04-protocol.md`, `docs/reference/05-drivers.md`
- **Created:** 2026-09-12, from a measurement of what the orchestrator actually does
- **Dependencies:** none

## Context

Acceptance already has a name and an owner. The consumer's glossary defines **approver**: the role that merges the branch, archives the task and fixes the index — "under orchestration, the orchestrator". The recipe is written out as prose in the consumer's run guide: squash, gates **on the merged tree** rather than only the worker's, archive, clean up the participants.

What does not exist is an address for it. `src/protocol.ts:30` closes the address to `orchestrator | worker:<slug> | reviewer:<slug>`; the store layer accepts an arbitrary role string (`src/v1/model.ts:23`), so the two layers already disagree about what a role is.

The price of that gap is paid by the orchestrator, and it is measurable: of its 12 172 Bash calls, **16.8 % are gate runs and 8.2 % are merge, archive and move commands** — a quarter of everything it executes. It is also the session with the least room: p50 315 model requests, p90 1013, max 1734, and it is the only reader of 3410 inbound messages.

> Source: 2026-09-12, transcripts of 37 orchestrator sessions; `orch2.py`, `turns.py` in the session scratchpad.

Two decisions are already on the record and constrain this one.

- [ADR-009](../../adr/adr-009-reviewer-resolves-no-discrepancy.md) refuses to loosen the reviewer's deny list. So acceptance cannot be "the reviewer with rights" — it needs its own participant or its own verb.
- [ADR-012](../../adr/adr-012-stopping-one-participant-is-a-verb-of-its-own.md) decided the shape of this exact question once: an action over one participant became a verb of its own, and the option of a flag on `done` was rejected there with reasons. This card must say why it is not repeating the rejected option.

What a fourth role costs, measured by reading the code rather than guessing: the address regexp and two refusal texts, the participant file stem (a `reviewer-` branch exists, a third would collide with a worker slug), the MCP render, three refusals in `lib/store.js`, the lift map in `lib/liftoff.js`, **four independent copies of the role list** in model routing, `qualityFloor` (`worker: 5`, `reviewer: 9` — the new role needs its own), three model-routing schemas, the CLI help, and the role table in the consumer's skill. Two further points deserve their own line: `routingPolicy` permits a message only when one end is the orchestrator, so approver ↔ worker traffic is refused today; and `participantDenyTools(role)` is a **public host contract member**, called so far only with the literal `'reviewer'`.

**Correction 2026-09-12.** The scope line above first named `docs/reference/16-spawn.md`. That page does not exist in this repository and never did — `docs/reference/` here holds 01 through 05, and git records no deletion of such a file. The page with that name belongs to the consumer, whose reference numbering runs further than this one's; editing it is part of the consumer's own card. `lint` did not catch the bad name because the card cites it as inline code rather than as a markdown link. The driver page of this repository, `docs/reference/05-drivers.md`, is where the lift of the new role is documented.

## Work to do

- Decide between the role and a verb, with the price of each named in the card — the list above is the price of the role; the price of the verb is that acceptance keeps running inside the orchestrator's context and its session stays the bottleneck.
- If the role wins: keep the glossary word `approver`, do not introduce a second term for the same thing; state its deny list, its quality floor, and whether `routingPolicy` opens for it.
- Say who lifts it and when — after a green review of a piece, not at the start of a run.
- Record the decision as an ADR. The consumer fixes a three-role pipeline in an ADR of its own, and a fourth role rewrites that statement there too — the consumer's card carries that half.

## Out of scope

- The cleanup it performs — PB-208.
- The skill text and the run guide on the consumer side — that is a separate card in the consumer's backlog.
- Any change to the reviewer's permissions — refused by ADR-009.

## Checks

- The address is accepted end to end: protocol, store, MCP render, CLI help and the file stem agree, and a message from the new address reaches the orchestrator and a worker.
- A live run where the new participant runs the gates on the merged tree and performs the squash, and the orchestrator's own Bash calls for that run contain no gate run and no merge — measured, not asserted.
- The existing three-role tests stay green, including the address refusal test and the schema-parity test.
- One word in the glossary, not two: a grep finds `approver` and no synonym.
- The quality floor of the new role is named with a reason, not copied from the reviewer by default.
