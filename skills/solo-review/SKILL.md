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

`--dry-run` prints the plan. `--harness` selects the runtime (must be in `promptobus.json` `tools`). `--model` and `--effort` are harness-specific.

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
