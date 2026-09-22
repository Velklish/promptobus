# PB-237 · The --approver refusal names a reviewer but not the subject it must have lifted from

- **Order:** 450
- **Scope:** [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-22
- **Dependencies:** none

## Context

Raising an approver for the first time, from the root of the clone rather than
from the reviewed worktree, refuses like this:

```
✖ --approver requires reviewer:diffalanche to have lifted from this review
  subject — no such reviewer participant is recorded in task
  da-w2-t20260921-171045.
```

Everything in that sentence is true and none of it says what to do. "This
review subject" is the path argument, and the requirement is that the same
path was reviewed earlier — so the caller has to pass the **worktree** the
reviewer read, not the repository root. The refusal never names a path,
neither the one it got nor the one it wanted, and the invented address
`reviewer:diffalanche` is derived from the wrong path rather than reported as
wrong.

The second attempt, with the worktree path, succeeded immediately. The cost
was one wasted lift and a guess; the information needed to avoid it is
already in the caller's hands when the refusal is composed.

Observed twice on 2026-09-21 in a run over `external/diffalanche`, once per
approver.

## Work to do

- Name both paths in the refusal: the subject that was passed and the subjects
  this task has reviewers for. A task knows the paths its reviewers lifted
  from, and printing them turns the refusal into an instruction.
- Say what the rule is rather than restating the failed predicate — an
  approver is lifted for a piece that has been reviewed, so the subject must
  be the one the reviewer read.
- Check the neighbouring refusals for the same shape: `promptobus_send` to an
  unknown address already lists the addresses it knows, which is the behaviour
  this one is missing.

## Out of scope

- Whether the rule itself is right. Requiring a green review before an
  approver is the intended order.

## Verification

- The refusal, on the same mistake, prints the path that was passed and the
  paths that would work, and a reader who has never lifted an approver reaches
  the right command from the message alone.
