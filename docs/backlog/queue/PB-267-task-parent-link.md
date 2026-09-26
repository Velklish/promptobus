# PB-267 · A task can have a parent: teamlead in the parent, a tree in status, done refuses over active children

- **Order:** 40
- **Scope:** [01-overview](../../reference/01-overview.md), [04-protocol](../../reference/04-protocol.md), `schemas/v1/task.schema.json`, `src/v1/model.ts`, `lib/status.js`, `lib/done.js`
- **Created:** 2026-09-26
- **Dependencies:** PB-266
- **Cost:** major

## Context

Every task is flat today: one `orchestrator`, its participants, its journal. The owner decided on 2026-09-26 (ADR-021) that a run may be a tree of exactly two levels: a root task owned by the top orchestrator, and child tasks each owned by a teamlead. A child task is a task of its own — mailboxes, warden, guard and routing unchanged inside it — and the parent holds one participant `teamlead:<slug>` per child, bound to the same session that owns the child (PB-265). A one-task tree stays a legal task and is what every task is today.

## Work to do

- `task.json` gains an optional `parent` (a task id); the schema forbids a parent that itself has a parent, and the store refuses to create a third level.
- Registering `teamlead:<slug>` in the parent and setting the child's owner happen in one step, so a child without its parent record, or the reverse, cannot exist after a crash: the recovery path names and repairs a half-written pair.
- `promptobus status` prints the root task and its children indented under it, each child with its own participant lines; `promptobus_task` reports `parent` and `children`.
- `promptobus done` on a root task refuses while any child is active and names it; `done` on a child leaves the parent's `teamlead:<slug>` record with its last result and closes only the child.

## Out of scope

- Lifting the teamlead session (PB-269) and the routes between tree members (PB-270).
- Cascading `done`: the owner's decision is a refusal, not a sweep of the tree.

## Verification

- A child task created with `parent` shows under its root in `status` and in `promptobus_task`; a `parent` that points at a child is refused by schema and by the store.
- `done <root>` with one active child exits non-zero naming the child; after `done <child>` it succeeds.
- A crash injected between the two writes of the parent–child pair (the suite's fault hook) leaves a state that `recover()` repairs and names.
