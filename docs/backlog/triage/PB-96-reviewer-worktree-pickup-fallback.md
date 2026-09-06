# PB-96 · A repeat solo review needs the task id typed back in, because directory pickup recognises worker worktrees only and never the reviewer's own record

- **Scope:** [03-cli](../../reference/03-cli.md) § Review, `lib/review.js`, `skills/solo-review/SKILL.md`, `test/promptobus-review.test.mjs`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

skills/solo-review/SKILL.md:45 — "After you fix findings, rerun the command that `promptobus review` printed, with `--task <id>`. The same reviewer gets the new diff. `--task` is required on that repeat: without it the command would open a second task." Re-verified verbatim.

`claimingTasks` (lib/review.js:847-849) filters active tasks by `worktreeOwner` (lib/review.js:837-840), which matches only `p.metadata.worktree` — a field worker participants carry (every `worker(...)` fixture in test/promptobus-review.test.mjs sets `worktree`/`worktreeName`) but reviewer participants never set. A reviewer's own record instead carries `repoAbs: plan.repoDir` (lib/review.js:694). So `claimingTasks` always returns empty for a directory that only a reviewer, not a worker, is registered against — exactly the case of re-reviewing one's own main clone, which is how solo-review's own description frames its ordinary use ("review your own diff").

The comment above `claimingTasks` (lib/review.js:842-846) explains a different, deliberately rejected fallback: "We do not check `repo` — the field is also on the reviewer record, and the target would be listed in every task where the repository was ever reviewed." `repo` is the repository's namespace path and recurs across unrelated tasks; `repoAbs` is the literal reviewed directory, a narrower field the comment's reasoning does not cover.

No test exercises the reviewer-only case: test/promptobus-review.test.mjs:1120-1129 covers the analogous *worker*-worktree pickup ("a forgotten `--task` on one's own worker's worktree is no longer a bug... It used to open its own second active task"), and every other re-review check in the file (lines 1019-1065, 1230-1256) passes `task: owned.id` explicitly or targets a worker's worktree.

`p.role === 'reviewer'` and `p.metadata.repoAbs` are both established idioms elsewhere (lib/models.js:337, lib/codex-session.js:509,992), so the fix mirrors an existing pattern rather than introducing a new one. Not tracked in docs/backlog or docs/archive (grepped for `repoAbs`, `claimingTasks`, "second task", "re-review" — no match on this gap; PB-37.2 is unrelated).

## Work to do

- In `claimingTasks` (lib/review.js:847-849), after matching by `worktreeOwner` (unchanged), add a fallback that also matches active tasks holding a participant with `p.role === 'reviewer'` and `canonical(p.metadata.repoAbs) === repoDir` (the same `canonical()` comparison `worktreeOwner` already applies to `worktree`). Union both matches into the `claiming` array read at line 179, so the existing `claiming.length > 1` refusal (lines 180-183, already lists ids and says "the command will not choose for the person") naturally covers a directory claimed by both a worker worktree and a reviewer record.
- Update docs/reference/03-cli.md § Review to describe the reviewer-record fallback alongside the existing worktree-owner pickup.
- Update skills/solo-review/SKILL.md:45 to drop or soften the "`--task` is required on that repeat" instruction to match.
- Add a test to test/promptobus-review.test.mjs parallel to the block at lines 1120-1129, targeting the reviewer's own directory with no worktree owner.
- CHANGELOG.md entry.

## Out of scope

- The `repo`-field fallback the existing comment already rejects — this proposal is narrower (`repoAbs`, `role: 'reviewer'`, active tasks only).
- Any change to the several-worktrees / several-claims refusal itself (lines 180-183) beyond letting a reviewer-record match feed into it.

## Verification

- New test: a reviewer's own directory with an active task and no worker worktree on it — `review` without `--task` picks up that task rather than opening a second one.
- Existing worker-worktree pickup test (lines 1120-1129) still passes unchanged.
- A directory claimed by both a worker worktree and a separate reviewer record — the several-claims refusal fires and names both ids.
- `npm test`, `npm run lint:backslop` green.
