# PB-157.1 · Review snapshot calls a tracked tree dirty when only a file's stat changed, because the worktree raw record carries a zero blob id until the index is refreshed

- **Order:** 1090
- **Scope:** `lib/review.js` (`snapshotDiff`), [03-cli](../../reference/03-cli.md) § review (the snapshot line), review tests
- **Created:** 2026-09-09
- **Dependencies:** none

## Context

`snapshotDiff` (`lib/review.js`, the function above `planReview`'s snapshot call) decides `modifiedTracked` by comparing the raw records of `git diff --raw --stat --patch <base>` (working tree) with those of `git diff --raw <base> <head>` (committed). A raw record carries both blob ids. For a path whose content differs between `<base>` and `HEAD`, git prints the working-tree side of the record from the index entry when the entry's stat information is fresh, and as `0000000` when it is not — even when the file's content equals HEAD. The two records then differ and the path is reported as modified.

Reproduced on `main` at `5674a86` in a clean clone (`git status --short` empty), path `lib/model-routing/catalog.js`, changed by PB-155 since base `35698a7`:

    git diff --raw 35698a7 -- lib/model-routing/catalog.js        → :100644 100644 d5105e0 4a1e54e M
    touch lib/model-routing/catalog.js
    git diff --raw 35698a7 -- lib/model-routing/catalog.js        → :100644 100644 d5105e0 0000000 M
    git diff --raw 35698a7 HEAD -- lib/model-routing/catalog.js   → :100644 100644 d5105e0 4a1e54e M
    git status --short -- lib/model-routing/catalog.js            → (empty; the index is refreshed by it)
    git diff --raw 35698a7 -- lib/model-routing/catalog.js        → :100644 100644 d5105e0 4a1e54e M

Live exposure in run `pb-run-0909-t20260909-132344`, twice in a row: a worker's mutation probe restores the fixed file (`git restore --source=HEAD`), which changes its stat while leaving the content equal to HEAD; the worker's own `git diff --exit-code` reports exit 0; `promptobus review` on that worktree 30–40 s later printed `tracked tree dirty (modified tracked paths: lib/cursor-persist.js)` (13:47:05 UTC, `worker:drivers`, HEAD `d6b9ced`) and `… (src/v1/messages.ts)` (13:48:03 UTC, `worker:s-store`, HEAD `3748881`). An orchestrator `git status` in each worktree found nothing modified, and the next `promptobus review` (13:47:41, 13:49:00) printed `tracked tree clean` with no commit in between. Each false line sends the reviewer a warning that its snapshot may be wrong and costs a second snapshot.

## Work to do

- Refresh the index stat information before the snapshot reads — `git update-index -q --refresh` in `snapshotDiff`, or an equivalent that makes the working-tree raw record carry the real blob id — so a stat-only change no longer differs from the committed record. Alternatively, for the paths whose records differ, compare working-tree content with HEAD (`git diff --quiet HEAD -- <path>`) and report only the paths that actually differ.
- Keep the real-dirty case: a path whose content differs from HEAD is still reported.
- Test: commit a change to a file, then `touch` it (or rewrite it with identical content) and take a snapshot — `modifiedTracked` is empty; rewrite it with different content — the path is listed.

## Out of scope

- The snapshot-versus-current-file check the reviewer prompt asks for (PB-157) — unchanged.

## Verification

- The reproduction above prints `tracked tree clean` after the repair, and the new test is red on the pre-repair code.

## Triage — 2026-09-09

- **Track:** L — Spawn, review and command guidance.
- **Priority:** P2.
- **Evidence level:** reproduced on `5674a86` with the commands above; two live occurrences in the same run.
- **Next step:** queued; a one-file repair, independent of the other L tasks. Orchestrator workaround until then: `git update-index -q --refresh` in the worktree before `promptobus review`.
