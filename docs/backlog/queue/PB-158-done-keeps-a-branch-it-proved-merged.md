# PB-158 · `done` removes a worktree on proven squash containment but leaves its own branch behind, because the branch check falls back to an ancestry test that cannot answer for a squash

- **Order:** 1080
- **Scope:** `lib/done.js`, `lib/worktree.js`, [03-cli](../../reference/03-cli.md) § done, worktree cleanup tests
- **Created:** 2026-09-07
- **Dependencies:** none

## Context

`worktreeDisposition` (`lib/worktree.js:200-233`) already decides that a squash-merged branch's work was taken, and it does so on evidence rather than on ancestry. Its own comment states why ancestry cannot be used: "A squash merge leaves NONE of the branch's commits in the base by construction, so the count above says nothing about whether the work was taken. Two content measurements answer that, and the message names which one did (PB-6)." The two measurements are `adds === false` — merging the branch into the base would add nothing — and `squashed === true`, the base holding a commit with this branch's own patch-id. Either one returns `action: 'remove'`, and the worktree directory is removed on it.

The branch is then handled by a weaker test. `lib/done.js:189-190` reports it as stuck — "branch … left in place: `git -d` does not consider it merged (this happens after a squash merge)" — and prints `git branch -D` for the person to run. `git branch -d` is exactly the ancestry test the code above already ruled out as unable to answer this question.

So one proven fact justifies deleting the directory and not the branch it belongs to. Either the proof is good enough for both, or for neither.

Observed on every run that ends this way. Two runs on 2026-09-07 (`pb-qprep-t20260907-160618`, `pb-prep2-t20260907-201826`) each removed their worktree with the reason "merged as a squash — its 7 / 8 commit(s) are not in main, and merging them into main would add nothing", and each left `worktree-promptobus-…` standing. Branches accumulate one per accepted run, and the only thing the person can do with the printed command is confirm a decision the tool already made.

The owner's decision, 2026-09-07: after the task is merged the branch is deleted, and the worker's per-commit history is discarded with it. The substance of the work lives in the archived `result.md`, and the course of the review lives in the task journal; the intermediate commits carry nothing that is needed after acceptance.

## Work to do

- Delete the branch in the same step that removes the worktree, on the same proven disposition, using a force delete since `-d` cannot confirm a squash. Restrict it to branches the mechanism created — the `worktree-` prefix — exactly as the existing cleanup already does for the ancestry case.
- Keep the current refusal untouched for every disposition that is not `remove`: an unmerged branch, a dirty tree, an unreadable comparison. Those already say what is wrong and ask the person to take or delete the work themselves, and that is right.
- A branch the worker moved to itself is not the mechanism's to delete; the existing rule that only the spawn-created branch is touched stays as it is.
- State it in `docs/reference/03-cli.md` § done: what is removed, on what evidence, and what is deliberately left standing.

## Out of scope

- The disposition logic itself — the two content measurements are what PB-6 built and this entry relies on them rather than changing them.
- Deleting a branch whose worktree is kept for any reason: the two decisions stay tied together.
- Any remote branch. This is local cleanup only.

## Verification

- A run accepted by squash into the default branch ends with neither the worktree directory nor the `worktree-` branch present, and `done` names both removals with the measurement that justified them.
- A branch with work not in the base still keeps both, with today's wording.
- A worker that moved its worktree to a branch of its own keeps that branch, and `done` says so.
- `npm test` stays green.

## Triage — 2026-09-07

- **Track:** L — Spawn, review and command guidance (`lib/done.js`, `lib/worktree.js`).
- **Priority:** P2. Nothing breaks; the person is asked to confirm a decision the tool already made, and one branch is left standing per accepted run.
- **Evidence level:** source review at `66ac26b` — `lib/worktree.js:200-233` against `lib/done.js:189-190` — plus two live runs on 2026-09-07 that each removed the worktree and kept the branch.
- **Next step:** implement as written. The owner has decided that the per-commit history goes with the branch, so no preservation step is owed.
