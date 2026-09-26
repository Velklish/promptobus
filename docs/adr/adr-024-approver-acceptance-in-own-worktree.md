# ADR-024: Approver acceptance in its own worktree

**Status:** Accepted
**Date:** 2026-09-26
**Deciders:** the repository owner

## Context

[ADR-015](adr-015-approver-lift-is-a-flag-on-review.md) seated every approver at the clone root. Cursor reads its project layer from the selected workspace, and Codex reads project skills and hooks from the thread's project or participant home. A lift could either miss that layer or overwrite untracked content in the shared clone. The clone root also gave two approvers one index and working tree. The owner decided on 2026-09-26 to move acceptance into an approver worktree.

## Options

**A — an approver worktree from local main.** The launch layer and acceptance writes stay in a worktree that the bus records and sweeps. The clone root receives the final commit through a fast-forward.

**B — a participant-owned project layer while acceptance stays in the clone root.** This still leaves two approvers sharing an index and requires each harness to deliver hooks and skills through a different path.

**C — exclusive rental of the clone root with byte-exact restore.** This needs an atomic lease across pending, detached and closed-but-live sessions, and must preserve every existing project file through failure and cleanup.

## Decision

Choose A. `review <subject> --approver` still requires a current reviewer result for that subject. A fresh lift creates a separate worktree and branch at the clone's local default branch. The session cwd, project files, squash, gates, archive, fold and acceptance commit all belong to that worktree. The clone root is attached only for the final `git -C <clone> merge --ff-only <approver branch>`, run inside `promptobus lease --key <clone> -- <command…>`. The clone root must be on the default branch. No lift overwrites an existing launch file it did not write.

Two approvers may work at once in separate worktrees. A lease keyed by the canonical clone root serialises their publication commands, including Git's checkout and index updates. The first successful fast-forward advances the clone's default branch. If the second fast-forward refuses because the branch moved, that approver redoes its squash on the new default branch, reruns its gates and retries. In a controlled two-publisher test, the refused fast-forward left the clone's index, tracked tree and untracked content unchanged. The lease covers bus publishers that use it; unrelated Git commands are outside this contract.

The keyed lease records the publication command's pid before it can touch the clone. If its wrapper is killed, the lock remains held until that command exits. Automatic recovery requires proof that both pids are dead. A missing child pid after wrapper death requires an operator to verify both processes are dead before removing the lock. The machine measurement lease keeps its separate wrapper-pid recovery rule.

This supersedes ADR-015's working-directory, clone-concurrency and harness-count decisions. Its `review --approver` command and reviewer-result precondition remain in force.

## Consequences

- `done` and `sweep` treat an approver's recorded worktree and branch like a worker's; a live session or untaken branch keeps them in place.
- A fresh approver worktree runs the repository's declared generator and dependency install before launch files. A repository whose tracker adapters are generated outside `promptobus.json` still follows its own `AGENTS.md` before gates.
- Claude Code keeps its normal background worktree isolation. A live Codex lift recorded a SessionStart hook event from a hooks file naming `--role approver:…` and left the clone root's tracked and untracked content intact. Codex refuses foreign clone-root hooks and malformed clone-root config before lift; valid clone-root config did not widen the effective MCP list in the measured probe. Cursor remains refused until its own live proof meets the same bar.
