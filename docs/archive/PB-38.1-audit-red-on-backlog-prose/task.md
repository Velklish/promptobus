# PB-38.1 · `npm run audit` is red at HEAD: two backlog files name the internal repository and an internal tracker id, and the gate scans the whole tree

- **Scope:** `docs/backlog/active/PB-39-codex-lift-waits-for-first-turn-end.md`, `docs/backlog/triage/PB-40-fresh-worktree-lacks-generated-skills.md`, `scripts/audit-public.mjs`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`npm run audit` exits 1 on `worktree-promptobus-series-0906b-cursor-t20260906-071317` at commit `5c48e9c`, with the working tree of PB-38 not yet touching either file:

```text
✖ origin CLI name: docs/backlog/active/PB-39-codex-lift-waits-for-first-turn-end.md
✖ origin CLI name: docs/backlog/triage/PB-40-fresh-worktree-lacks-generated-skills.md
✖ origin tracker ids: docs/backlog/triage/PB-40-fresh-worktree-lacks-generated-skills.md
✖ publicity audit: 3 finding(s)
```

The two rules are in `scripts/audit-public.mjs:22` and the lines beside it: the published tree must not name the internal agents repository, and must not carry an internal tracker id. PB-40's own Context paragraph names both — the repository by name and one of its tracker ids — and PB-39 names the repository. Both files were written by the run's orchestrator in `c490ed1` and `5c48e9c`; the status directories are not a worker's to edit, so PB-38 reported this rather than fixing it.

The red is therefore **not** a regression of the change under PB-38, and the gate cannot go green on this branch until the prose is rewritten.

## Work to do

- Rewrite the two paragraphs so the fact survives without the two forbidden strings — the neighbouring repository can be named by its role ("the workspace's agents repository") and the internal tracker id dropped, since the evidence a reader needs is in this repository.
- Decide whether the gate should scan `docs/backlog/` at all, or only what `npm pack` ships: the tarball listing above it is what "publicity" means, and a triage note that never leaves the repository is a different question from a file that does. If it should, say so in the reference beside the gate so the next finding is written for it.

## Out of scope

- The findings PB-39 and PB-40 themselves — their content is right, only the two strings are not publishable.

## Verification

- `npm run audit` exits 0 on a tree carrying both files.
