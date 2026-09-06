---
name: solo-review
description: Isolated review of your own diff. A read-only Promptobus reviewer session reads the change with a fresh context and sends findings on the bus. Use when asked to raise a reviewer, check a diff, or review a branch with new eyes. Not for spawning workers or running a multi-repo task (that is orchestrate).
---

# Solo review

The reviewer is a separate background session. Your context does not flow into it. Orchestration is not required. One command is enough.

```bash
promptobus review <path-to-clone-or-worktree> --title "<whose work, what changed>"
```

The path is required. There is no resolve from the current directory. An error without a path names the repository of `cwd` and prints a ready command.

`--title` is required when the command opens a new task. The title becomes the task name and the reviewer session name.

Default diff base is the repository default branch. In a worker worktree it is the merge base with that branch, recomputed at review time. Set `--base <sha|ref>` when you review work on top of another accepted branch.

`--dry-run` prints the plan. `--harness` selects the runtime (must be in `promptobus.json` `tools`). `--model` and `--effort` are harness-specific. `--strategy` picks the model for you; see [Reviewer strategy](#reviewer-strategy).

## Reviewer strategy

`--strategy quality` is the reviewer's default. Pass it unless the user named something else: a reviewer that misses a defect is paid for by the next round, and reading a diff is cheap next to writing it.

**Diversity.** A reviewer whose harness or model differs from the worker's scores higher — the resolver gives it a bonus, because a second reading with the same blind spot is not a review. Prefer a different harness when the workspace declares more than one and the user allowed it. Stay on the worker's harness only when the user pinned it, or when nothing else is available.

`promptobus models --strategy quality --role reviewer` prints what that would pick before you start the reviewer. `--strategy` is one of `quality`, `balanced`, `speed`, `economy`, `balance`; without it the command takes the recorded default if there is one, and otherwise routes nothing and takes the defaults. `--harness`, `--model` and `--effort` stay constraints — a value the user named is never replaced by a strategy.

**The reviewer follows the same recorded default as a worker.** If the person has agreed a switch — `promptobus models strategy --set <name>`, which the orchestrator proposes when `models` prints a `near-limit` line and never runs on its own — a `review` with no `--strategy` routes with it. Pass `--strategy quality` when the reviewer's own bar matters more than the account balance; that is the flag winning over the default, which is the rule everywhere.

Nothing pins the reviewer to one harness. Under `balance` it is routed by the pace of the accounts like a worker, with the reviewer quality floor of 5 above it and the diversity bonus on top — a reviewer on a different harness or model from the worker's scores higher, because a second reading with the same blind spot is not a review.

The rubric that turns a task into one strategy is in [orchestrate](../orchestrate/SKILL.md) § Model routing.

## Collect the report

The report arrives as `type=result` on the bus.

1. End the turn. The warden knocks when the report is in the mailbox.
2. Read with `promptobus_mailbox`, even if the knock looks complete.
3. If the reviewer is alive and sends `type=question`, answer with `promptobus_send` to that address.
4. After you fix findings, rerun the command that `promptobus review` printed, with `--task <id>`. The same reviewer gets the new diff. `--task` is required on that repeat: without it the command would open a second task.

## Close

The two halves are independent:

- Stop the reviewer session in the harness (the driver route is in `promptobus status`).
- Close the task: `promptobus done --task <id>`. The review command prints this line.

A leftover active task forces every later command to take `--task`.

## Not this skill

- Workers, several repositories, a full run: [orchestrate](../orchestrate/SKILL.md)
- A diff you can read in one screen: read it yourself
