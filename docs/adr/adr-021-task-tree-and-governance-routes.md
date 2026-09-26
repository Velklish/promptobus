# ADR-021: A task tree of two levels with governance routes

**Status:** Proposed
**Date:** 2026-09-26
**Deciders:** the owner, in the planning dialogue of 2026-09-26. The text is drafted by the planning session and is not yet reviewed by the owner; the status turns Accepted when PB-267, PB-269, PB-270 and PB-271 land.

## Context

One orchestrator carries every participant's traffic. The owner's measurement of 33 task journals on 2026-09-26 puts the five largest runs at 400 to 832 messages to the orchestrator and 344 to 877 thousand characters of inbound mail, more than one session context. The owner's structure: a top orchestrator (the owner calls the role TGM) lifts teamleads, each running its own group of workers; teamleads of one group talk to each other about small matters and bring a change of logic or of requirements to the top; teamleads of different tops do not talk; tops lifted by the person may ask each other questions. The person changes only the steps below a teamlead ([ADR-020](adr-020-role-registry-and-declared-pipeline.md)); the layer above them is fixed by the package.

## Options

**Decision 1 — the shape of a run.**
- 1A. A tree of tasks: a root task owned by the top, one child task per teamlead with a `parent` link, the teamlead recorded as `teamlead:<slug>` in the root and as `orchestrator` of its child — one session, two addresses ([ADR-019](adr-019-session-address-per-task-lands.md)).
- 1B. One task with every level's participants. Rejected: the one-orchestrator-per-task rule, the claim, the warden and every route would be rewritten for a tree inside one journal.

**Decision 2 — depth.**
- 2A. Exactly two levels. 2B. Arbitrary depth. Rejected: every "who may write to whom" check would carry a recursion for a case nobody has measured.

**Decision 3 — the small/large boundary between siblings.**
- 3A. By message type: `question`, `answer`, `status`, `artifact` between siblings; `task`, `result`, `review` only on the vertical; what is large is written in the teamlead's instruction.
- 3B. Text only. Rejected: a violation would be visible to nobody.
- 3C. 3A plus a new upward-only type. Not taken now: the type list is frozen and no case needs it yet.

**Decision 4 — peers.**
- 4A. An explicit `link` on both sides, each peer bound to the other's owner session, and only the sibling types. 4B. Any orchestrator writes to any task by name. Rejected: an address that can be named can be borrowed (ADR-011).

**Decision 5 — where a teamlead sits.**
- 5A. At the install root, like the top; its group is the set of repositories in its brief. 5B. In one repository's directory. Rejected: awkward for a group of several.

## Decision

1A, 2A, 3A, 4A, 5A. `done` on a root refuses over an active child rather than cascading. A teamlead and a reporter lift on Claude Code first; Cursor and Codex read their project layer from cwd and are refused with the reason of [ADR-015](adr-015-approver-lift-is-a-flag-on-review.md) until the clone-root rental card lands.

## Consequences

- Routing gains a closed table with a decision column; every pair outside it is refused naming the vertical route.
- The top orchestrator's inbound traffic becomes the teamleads' summaries instead of every worker's mail.
- Thresholds for raising a tree — up to 5 pieces and 3 concurrent workers for one orchestrator, from 8 pieces or 4 concurrent workers or two groups for a tree — ship in the package skill and are the owner's reading of the measurement, to be re-read against later telemetry.
