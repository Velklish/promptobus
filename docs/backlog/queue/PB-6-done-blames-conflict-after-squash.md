# PB-6 · done explains a leftover worktree with a conflict where the branch was squash-merged

- **Order:** 200
- **Scope:** [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-05
- **Dependencies:** none

## Context

Reported by the first consumer from a live run on 2026-09-04. After the orchestrator accepted a worker branch with a **squash** merge, `done` left the worker's worktree behind with the line “N branch commit(s) are not in main (merging them with the base failed — a conflict or an old git) — take them (merge/MR) or delete yourself”. A squash merge by construction leaves none of the branch commits in main, so the cleanup criterion “branch commits reachable from main” is never met, and the message blames a conflict that did not happen.

## Work to do

- Cleanup decides by *content*, not by commit ancestry: a branch whose diff against its base is fully contained in main (`git diff base...branch` applied to main is empty, or `git cherry`/patch-id equivalence) is merged; only a branch with unmerged content is kept.
- The message names the real state: “merged as a squash” vs “not merged”.

## Out of scope

- Nothing named yet.

## Verification

- Fixture: squash-merged branch → worktree removed, no conflict text; branch with an unmerged commit → kept with the honest text.
