# PB-453 · Verify participant worktree setup and launch diagnostics

- **Order:** 760
- **Scope:** [Participant launch](../../reference/README.md)
- **Created:** 2026-11-18
- **Dependencies:** none
- **Cost:** minor

## Work to do

- [PB-234.6 · A lifted worktree installs root dependencies only, so integrations/bb checks go red until a manual npm ci there](../minor/PB-234.6-bb-deps-missing-in-lifted-worktree.md).
- [PB-326.1 · A crashed node generator is reported by its last stderr line, not by its cause](../minor/PB-326.1-generator-crash-reason.md).
- [PB-416.17 · Record worker-role permission profile preflight misuse](../minor/PB-416.17-worker-role-profile-preflight-misuse.md).
- [PB-416.20 · Retain setup prerequisites for a manually created metadata worktree](../minor/PB-416.20-manual-worktree-generated-readiness.md).

## Verification

Check a clean lifted worktree separately from manual setup. Verify role-specific help and a synthetic generator crash. Retain the historical Stop refusal separately; documented setup needs no duplicate fix. Record the outcome against each original finding before archiving it.
