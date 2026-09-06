# PB-34.2 · `npm run audit` is red at `main` because backlog task files carry origin-workspace names — every worker's gate fails on text that is not theirs

- **Scope:** `scripts/audit-public.mjs`, `docs/backlog/**`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Found while running the PB-34 gates. `npm run audit` exits **1** on a tree with no code
changes to it, with three findings, and all three are in task files rather than in anything
the package publishes:

```text
✖ origin CLI name: docs/backlog/active/PB-39-codex-lift-waits-for-first-turn-end.md
✖ origin CLI name: docs/backlog/triage/PB-40-fresh-worktree-lacks-generated-skills.md
✖ origin tracker ids: docs/backlog/triage/PB-40-fresh-worktree-lacks-generated-skills.md
✖ publicity audit: 3 finding(s)
```

Verified pre-existing at `main`, not introduced by any work in flight: both files are
byte-identical between `HEAD` and the working tree (`git diff --quiet HEAD -- <file>` is
clean for each), and the forbidden strings are present in `git show HEAD:<file>` at line 10
and line 9 respectively. PB-40 arrived with the head commit of `main` (5c48e9c), PB-39 with
c490ed1.

The consequence is procedural and it costs a round every time. `audit` is one of the `gates`
in `backslop.json`, so the definition of done for **every** worker in a run includes a
command that is already red for reasons in another worker's task file — a file that worker
is forbidden to edit, since status directories are not a worker's. Each worker must
therefore re-derive, from scratch, that the red is not theirs. Two have to do it in this run
alone.

Two candidate fixes, and choosing between them is the decision this entry is for:

1. **The findings are correct and the text should change.** A backlog file that names the
   origin workspace's CLI and its tracker ids does leak them into a public repository, and
   the audit is doing its job. Then the fix is to rewrite those two files' wording, which is
   an approver's action rather than a worker's.
2. **The audit's field of view is too wide.** The package publishes `bin`, `dist`, `lib`,
   `models`, `schemas`, `skills`, `templates` and three root files (`files` in
   `package.json`); `docs/backlog/` is in none of them and reaches no consumer through the
   tarball. Then the scan should exclude the tracker's own working directories, and the
   guarantee it makes gets narrower and truer.

They are not equivalent: the second stops the recurring cost and lets a task file quote a
real command from the origin workspace, the first keeps the repository clean of those names
everywhere including its history.

## Work to do

- Decide between narrowing the audit's scan and rewriting the offending task files; record which, and why, where the audit's guarantee is documented.
- Make `npm run audit` green on a clean checkout of the default branch, so a worker's red gate is always the worker's.

## Out of scope

- Editing status directories as part of a worker pass — this entry exists so an approver does it.
- Weakening the forbidden-string list itself for files the package actually ships.

## Verification

- `npm run audit` on a clean checkout of the default branch: exit 0, zero findings — the exit code taken from the command itself, not from a pipe.
