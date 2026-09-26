# PB-266 · One registry declares every role and step: parser, stems, denies, floors, schemas, routes

- **Order:** 30
- **Scope:** [04-protocol](../../reference/04-protocol.md), `src/protocol.ts`, `lib/model-routing/catalog.js`, `schemas/v1/`, `schemas/model-routing/`, `lib/review.js`, `lib/approver.js`, `lib/spawn.js`
- **Created:** 2026-09-26
- **Dependencies:** none
- **Cost:** major

## Context

`ADDRESS_RE` in `src/protocol.ts` accepts `orchestrator`, `worker:`, `reviewer:` and `approver:`, while the participant schema declares `role` as an extensible slug. [ADR-013](../../adr/adr-013-approver-is-a-fourth-addressed-participant.md) records what adding the fourth role cost: address parsing and file stems, refusals, MCP rendering, routing, lift wording, model-routing role sets and floors, schemas, host permissions, CLI help and documentation each carried an independent copy of the contract, and the parity test written then found two pre-existing silent disagreements.

The owner's decisions of 2026-09-26 add addresses in two layers: governance roles that the package fixes (`teamlead`, `peer`, `reporter`, `user`; ADR-021, ADR-022) and pipeline steps that a declaration names (ADR-020). Neither can be paid for at ADR-013's price per role.

## Work to do

- One module declares the closed set of governance roles and the three step kinds — `edits-tree`, `reads-diff`, `writes-main-tree` — with, per entry: address shape, participant file stem, package deny list, quality floor, catalog role, whether it is routed, and its lift text key.
- The address parser, `participantFileStem`, `refuseParticipantPrefix`, the deny-list translation, `ROUTED_ROLES`, the schema enums and the routing policy read the registry instead of their own literals. Declared step names (PB-273) are admitted through the registry at host-config load, not by editing the regexp.
- The parity test enumerates every surface from the registry: adding a test-only role inside the test passes through all surfaces without a second edit.

## Out of scope

- New behaviour of any role: this card moves literals, it does not change what `worker`, `reviewer` or `approver` may do.
- The declaration file itself (PB-273) and the governance routes (PB-270).

## Verification

- `grep -rn "'worker'\|'reviewer'\|'approver'" lib src --include='*.js' --include='*.ts'` outside the registry and the tests returns only the registry's own entries; the parity test names any surface that keeps a literal.
- The existing suite passes unchanged: no address, stem, deny list or floor moves.
- The parity test with a synthetic extra role passes on every surface it enumerates.
