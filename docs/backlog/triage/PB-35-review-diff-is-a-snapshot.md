# PB-35 · The reviewer's diff file is a one-time snapshot while the worker keeps committing — the reviewer's brief should say so and offer a re-snapshot

- **Scope:** `lib/review.js`, the reviewer prompt, [03-cli](../../reference/03-cli.md)
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Observed 2026-09-06 in the subscription-balance run, twice: `promptobus review <worktree>` writes `files/review-<slug>.diff` once, at spawn; the worker goes on committing, so by the time the reviewer reads, the file lags the worktree (the PB-31 reviewer found the balance tests, two CHANGELOG entries, a reference section and a whole fixtures README missing from the diff, and read the working copy instead). A second reviewer saw the working copy revert to HEAD for a minute and come back — a `git stash` from a neighbouring worktree, the stash being shared. Today nothing in the reviewer's brief says the diff is a snapshot, so a reviewer that trusts it reviews an older state and reports closed findings as open.

## Work to do

- The reviewer's prompt names the diff file as a snapshot taken at `<time>` against `<base>` and tells the reviewer to compare against the worktree path for the current state.
- A re-review (`promptobus review` on the same worktree to the same live reviewer) already re-snapshots; say so in the reference next to the `--task` note, and print the snapshot time in the command's output.
- Consider a `--fresh` on the reviewer's side or a `promptobus_task` field with the diff's commit so the reviewer can tell how far behind it is.

## Out of scope

- Locking the worker's tree during review.
- The shared stash: that is the harness's worktree model, and AGENTS.md already warns about it.

## Verification

- A reviewer spawned on a worktree that then gains a commit: the prompt names the snapshot time; the reference paragraph exists; `npm test` on the prompt text.
