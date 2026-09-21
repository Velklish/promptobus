# PB-238 · review takes no --brief, so an approver's assignment has to travel as a separate message

- **Scope:** [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-22
- **Dependencies:** none

## Context

`promptobus spawn` takes `--brief <file>` and hands the worker its assignment
at lift. `promptobus review` does not:

```
known flags: --base, --task, --title, --model, --effort, --permission-mode,
             --harness, --strategy, --allow-payg, --refresh, --dry-run,
             --approver
```

A reviewer does not need one — its subject is the diff, and the diff is what
the lift sends. An **approver** does: the acceptance recipe, the decisions
already taken, and the list of what is not its work are exactly a brief, and
with `--approver` the same command now lifts a participant that has one.

Today that assignment travels as a `promptobus_send` with `artifactPath`
immediately after the lift. It works, and it has two costs. The session may
take its first turn before the message lands, so the participant starts
without knowing its task. And the assignment is no longer part of the lift
record: `spawn` keeps the brief it was given, this one keeps nothing.

Observed on 2026-09-21 over `external/diffalanche`, twice.

## Work to do

- Decide whether `--brief` belongs on `review --approver`, or whether the
  approver should be lifted by its own command. The second is a larger change
  and may be the honest one, since `review` now lifts two different roles with
  different needs.
- Whichever is chosen, the assignment of a lifted participant should be
  recoverable from the task afterwards, the way `spawn`'s brief is.

## Out of scope

- Briefs for reviewers. A reviewer's subject is the diff and it arrives with
  the lift.

## Verification

- An approver lifted with an assignment has it on its first turn, and the
  assignment is in the task's record without the orchestrator having sent a
  separate message.
