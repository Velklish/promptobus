# ADR-013: Approver is a fourth addressed participant

**Status:** Accepted
**Date:** 2026-09-12
**Deciders:** the run's orchestrator, under the owner's decision of 2026-09-12 that acceptance is the fourth role and is addressed `approver`. The remaining policy choices are made under the same mandate to close them in this ADR. **Not reviewed by the owner**: the line distinguishes the owner's fixed fork from the implementation decisions recorded here.

## Context

Acceptance already has one glossary name and one recipe. After a reviewer reports a piece
green, the accepting session merges or squashes its branch, runs the gates on the merged
tree, archives the task record and repairs the index. Today that work runs inside the
orchestrator's context. Across 37 measured orchestrator sessions, gates were 16.8 percent
of 12,172 shell calls and merge, archive and move commands another 8.2 percent; the same
sessions also held all 3,410 inbound messages. Acceptance therefore consumes a quarter of
the shell work in the only session through which every participant's context already flows.

The protocol cannot address the role the recipe names. `src/protocol.ts` accepts only
`orchestrator`, `worker:<slug>` and `reviewer:<slug>`, while the participant record itself
accepts a role string. Adding a role is not one regexp edit: address parsing and file stems,
refusals, MCP rendering, routing, lift wording, model-routing role sets and floors, schemas,
host permissions, CLI help and documentation all carry independent copies of the contract.
The consumer must also rewrite its three-role pipeline; that half belongs to the consumer's own card.

A verb alone has a smaller package surface. Its price is the reason for this ADR: acceptance
would continue to execute in the orchestrator's context, leaving the same session as the
gate, merge and archive bottleneck. Reusing the reviewer is not an alternative.
[ADR-009](adr-009-reviewer-resolves-no-discrepancy.md) fixes its read-only boundary and
refuses to relax it for operational work.

## Options

**A — add `approver:<slug>` as the fourth addressed participant.** Pay the distributed
contract cost above, give the role a routing policy, a tool boundary and a model-routing
floor, and let the consumer lift it at the point where acceptance begins.

**B — keep acceptance as a verb executed by the orchestrator.** The protocol stays at
three roles, but every merged-tree gate, squash and archive remains in the one context that
also owns all participant traffic. Rejected because it preserves the measured bottleneck.

**C — let the reviewer accept.** Rejected by ADR-009. Acceptance needs repository writes and
shell commands; granting them to the reviewer removes the read-only guarantee rather than
creating an acceptance boundary.

## Decision

**A. The only new role word is `approver`, and its address is
`approver:<slug>`.** A worker file stem stays `<slug>`; the new role's stem is
`approver-<slug>`, distinct from both worker and reviewer stems.

**The task orchestrator lifts the approver for one piece after that piece has a green
review, never at the beginning of a run.** Before the green verdict there is no acceptance
work to perform, and an early fourth session would spend context and quota while duplicating
the reviewer or waiting. The consumer's exact lift procedure remains the consumer's own card.

**The package deny list for the approver is empty.** `Edit`, `Write`,
`NotebookEdit` and `Bash` remain available because the role must run merged-tree gates,
squash and archive. A host may add exact environment-owned external MCP write tools through
`participantDenyTools('approver')`; the bus itself is never returned by that classification.
A translated MCP deny removes only the named external tool and does not select the
repository sandbox: the approver keeps write access. The standalone host answers
`{ tools: [], complete: true }`. This is deliberately separate from the reviewer deny
lists, which remain byte-for-byte unchanged under ADR-009.

**The approver quality floor is 7 on the ten-point scale.** Acceptance is mechanically
specified but its effects are not mechanically reversible: it must preserve the piece
identity across a squash, interpret gates on the merged tree and archive only the accepted
record. Band 6 is rejected because it admits rows assessed only one step above the ordinary
worker floor of 5 for a state transition whose wrong target is costly to restore. Band 8 is
rejected because it buys the stronger independent defect-finding judgement assigned to the
reviewer, while the approver starts only after that judgement is green and follows a recipe.
At 7 the shipped catalog offers 31 tuples across Claude Code, Cursor and Codex; floors 6 and
8 would offer 40 and 22 respectively. **The three-harness count is superseded for approver routing by [ADR-015](adr-015-approver-lift-is-a-flag-on-review.md):** only Claude Code lifts an approver, and the shipped catalog now offers 11 approver tuples on Claude Code alone. The threshold is therefore tied to the role's work,
not chosen as the midpoint between worker 5 and reviewer 9. Both routing and validation
read effective quality — the tuple's general rating with `roleRatings[role]` over it —
for the tuple and its assessed base row.

**Routing opens symmetrically between a worker and an approver.** This is a deliberate
exception to the base rule that participant traffic goes through the orchestrator. It
removes the relay from acceptance questions and hand-off evidence. Direct messages do not
appear as unread mail in the orchestrator's mailbox, so the orchestrator no longer observes
that exchange there; they remain canonical messages in the task journal and in the
addressed participants' histories, where the run can audit them. The sender must already
be registered in that task and its recorded session must match the calling harness
session. An explicit foreign-task argument cannot enroll an address into this route:
automatic foreign registration remains available only for mail to `orchestrator`.
Worker-to-worker, reviewer-to-participant and every other participant pair remain refused.

The action that cleans one accepted piece is still a separate verb under PB-208. This does
not repeat the option ADR-012 rejected. ADR-012 rejected a flag that made `done` mean less
than the whole task and chose a one-participant verb; here the role answers **who** owns
acceptance, while the PB-208 verb answers **what operation** it invokes. No flag is added
to `done`, and the task stays active.

## Consequences

- Acceptance leaves the orchestrator's execution context after green review; the
  orchestrator still owns the task and decides when the role is lifted.
- The protocol, model catalog and host contract gain a fourth role. Every future closed
  role list must account for `approver` explicitly.
- A host that constrains external MCP writes must classify the approver independently of
  the reviewer. An incomplete answer cannot be treated as an empty deny list by a consumer
  lift.
- Direct worker–approver traffic saves a relay but makes the task journal, not the
  orchestrator mailbox, the complete audit source for that exchange.
- The reviewer permission boundary does not move.
- The consumer's pipeline ADR, skill text and run guide are not changed here; the
  consumer's own card owns those changes and the live acceptance run that proves the
  role in that repository.
- This change pays the existing closed-list cost but does not redesign its sources.
  [PB-206.4](../archive/PB-206.4-model-routing-role-contract-has-independent-copies/task.md)
  records the separate consolidation. In exchange, parity now checks the exported
  runtime lists, both default maps and all six schema surfaces. That check found two
  pre-existing silent disagreements while it was being written: the overlay `byRole`
  map and `DEFAULT_POLICY.byRole`; targeted telemetry tests cover the remaining inline
  runtime projection.
