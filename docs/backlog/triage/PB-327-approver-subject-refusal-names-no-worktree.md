# PB-327 · An approver lift on the clone root says no participant is recorded and names no worktree that has a reviewer result

- **Scope:** [03. CLI § Review](../../reference/03-cli.md#review)
- **Created:** 2026-10-04
- **Dependencies:** none
- **Cost:** minor

## Context

On 2026-10-03 at 21:50Z the root orchestrator of run bs020 ran `review /…/external/promptobus --approver --brief … --task bs020-t20261003-125224`. It exited 1 with: "step approver requires a type=result message from reviewer:promptobus for subject /…/external/promptobus in task bs020-t20261003-125224's journal — no participant is recorded." The reviewer's result existed for the worker's worktree, `…/.claude/worktrees/promptobus-bs020-pb318-t20261003-125224`. The same command on that path lifted the approver.

The refusal names a reviewer address built from the clone name, which no participant has. It does not name the review subjects in this task that do have a reviewer result, which is the one fact the caller needs.

## Work to do

- When the subject has no reviewer, list the task's review subjects that carry a reviewer result, each with the `review … --approver` command for it.

## Out of scope

- The gate itself: an approver still needs a reviewer result on its subject.

## Verification

- An approver lift on the clone root of a task with one reviewed worktree names that worktree path in the refusal; a test fails on the old text.
