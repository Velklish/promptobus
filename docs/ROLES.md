# Roles

Who decides what in the tracker. The steps of a task are in the backslop section of `AGENTS.md`: the worker implements and verifies, the approver accepts and closes, and a single agent performs both roles in order. Under orchestration the orchestrator is the approver. The owner is the person who sets the goals. The tracker's own rules — directories, fields, numbering — are in [backlog/README.md](backlog/README.md).

This file belongs to backslop: an update (`npx --no-install backslop upgrade`, the `migrate` step) rewrites it from the template of the new version, and a local edit here does not survive the next update. Keep project rules of your own outside this file — for example, in `AGENTS.md` outside the backslop section.

## Worker

- Does not touch the card file of an existing task. When a card that sits in a status directory quotes a passage its own task changes, the worker names in its result which block to switch to `quote:before:`.

## Approver

- Sets the `quote:before:` marker on a card that already sits in a status directory without it.
- Decides without asking:
  - merge a duplicate into an existing task or clarify its wording;
  - put an entry in the queue and choose its place;
  - defer it with a return condition.
- Verifies a factual claim of an entry with evidence before queuing it, and rewrites unverified text as a hypothesis.
- Asks the owner **only before rejecting** an entry: a finding discarded without asking will not be rediscovered.

## Owner

- Sets the goals and reverses a priority when needed; ordering the work is the agent's job.
- Is asked before an entry is rejected, and about nothing else at review.
