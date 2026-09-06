# PB-35.1 · The publicity audit is red on HEAD: the PB-39 triage file names the origin CLI

- **Scope:** `docs/backlog/triage/PB-39-codex-lift-waits-for-first-turn-end.md`, `scripts/audit-public.mjs`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Found while working on PB-35, and not caused by it: `npm run audit` — one of the two gates in `backslop.json` — exits 1 on HEAD (`c490ed1`) with

```
✖ origin CLI name: docs/backlog/triage/PB-39-codex-lift-waits-for-first-turn-end.md
✖ publicity audit: 1 finding(s)
```

The line the audit trips on is line 9 of that file, which names the origin CLI in the measurement it records. `scripts/audit-public.mjs` forbids that name in every text file of the repository (`FORBIDDEN`, "origin CLI name"): the package is published, and the tracker travels with it.

Measured on 2026-09-06 in the PB-35 worktree: the finding names only that file, and no file changed by PB-35 appears in it.

## Work to do

- Reword line 9 of the PB-39 file so the measurement keeps its meaning without the origin CLI name — the harness is the workspace CLI, and the version is what matters to the measurement.
- Check the rest of the backlog for the same leak: the audit reports one finding per file, so a second file would only show after the first is fixed.

## Out of scope

- The PB-39 finding itself — that task stays as it is; this is about the name in its text.
- Loosening the audit's list of forbidden names.

## Verification

- `npm run audit` exits 0 on a tree with no other changes.
