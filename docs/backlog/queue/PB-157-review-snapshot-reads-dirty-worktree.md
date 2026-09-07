# PB-157 · The review snapshot is taken from the working tree, so a mandated post-commit mutation probe silently removes the reviewed change from the diff

- **Order:** 25
- **Scope:** `lib/review.js`, [03-cli](../../reference/03-cli.md) § Review, review tests
- **Created:** 2026-09-07
- **Dependencies:** none

## Context

`planReview` builds the diff the reviewer reads with a plain two-dot-less `git diff`:

```js
const from = baseRef ? git(repoDir, ['merge-base', baseRef, 'HEAD']) : { out: 'HEAD' };
const diffFrom = from.out;
const diffOut = gitRaw(repoDir, ['diff', diffFrom]);      // lib/review.js:313
…
const statOut = gitRaw(repoDir, ['diff', '--stat', diffFrom]);  // :319
```

`git diff <sha>` compares that commit with the **working tree**, not with `HEAD`. So the snapshot is `base → working tree`, and any transient state of the tree at that instant is what the reviewer judges.

That window is not rare — the repository's own procedure creates it. `AGENTS.md` step 4 requires: "Verify a test change with a mutation probe: **commit first, then run the probe**." A mutation probe means temporarily breaking the code under test. During it, the committed change is absent from the working tree, therefore absent from a snapshot taken at that moment — while `HEAD` still points at the commit that contains it.

Measured three times on task `pb-qprep-t20260907-160618`, 2026-09-07, every time against a Codex worker following that step:

- Commit `b4cb4a4` (PB-50) changes `lib/exec.js` in two hunks, 11 insertions: the two new constants at `@@ -5,6 +5,15 @@` and the `timeout:` / `maxBuffer:` defaults inside `run` at `@@ -175,6 +184,8 @@`. The snapshot written at 16:41:43 for worktree HEAD `b4cb4a4` (`files/review-promptobus-2.diff`) carries only the first hunk, 9 insertions. The behaviour change — the entire subject of the task — is not in the file the reviewer was given.
- Commit `6646247` (PB-141) behaved the same way: the reviewer received a `test/hygiene.mjs` diff of comment blocks only, with the `applyHygiene` body change missing, and reported `git status` showing `M test/hygiene.mjs`. `git show 6646247 -- test/hygiene.mjs` contains the body change.

The stat line agrees with the truncated hunk list because both come from the same working-tree read, so nothing inside the artefact contradicts itself. The reviewer has no way to detect the omission from the material it is given.

The guidance in the prompt points at the opposite failure mode. `subject()` (`lib/review.js:1042`) tells the reviewer: "The file is a SNAPSHOT … it is written once and never updated, while the author goes on committing. Everything committed **after** that moment is missing from it. … before reporting a finding, open the file there and check that the line is still as the snapshot shows it." That models staleness — the snapshot showing more than the tree. It does not model the tree showing less than `HEAD`, and following it literally makes a reviewer verify the wrong direction. The design comment at `:322-330` reasons about the same staleness race and concludes "There is nothing to fix in the file itself; what the reviewer needs is to know its age" — age is not the missing fact here; tree cleanliness is.

The third occurrence is the one that decides the shape of the fix. Before taking that snapshot the orchestrator deliberately checked the tree — `git status --porcelain` empty, "CLEAN" — precisely because of the two earlier cases, and took the snapshot seconds later at 16:58:08 with HEAD `d52fbec`. The snapshot still came out wrong: its third `lib/exec.js` hunk removes `timeout: PROC_TIMEOUT_MS` and `maxBuffer: GIT_MAX_OUTPUT` from `run`, while `git show d52fbec -- lib/exec.js` touches only the import block and `git show d52fbec:lib/exec.js` has both lines at `:190-191`. The author had started the next probe in the gap between the two reads.

So a pre-check by the caller cannot close this: the check and the diff are separate reads of a tree that a live author keeps moving. Whatever is recorded has to be read in the same pass as the diff itself, or derived from it.

The file-list check does not close it either, and this is worth stating because it looks like it should. `git diff --stat <base>..<head>` against the snapshot's own file list matched exactly on that third snapshot — `lib/exec.js` is legitimately in both — while the hunks inside it disagreed. Names and counts cannot see this class of divergence.

Consequence in practice: two reviews of that run produced a `[major]` finding claiming the repair had been left uncommitted, and the third produced a state question the reviewer explicitly could not settle from its own material. Both were false, both cost a round trip to disprove with `git show`. The symmetric failure is worse and did not happen only by luck: an in-flight edit that is **not** committed enters the diff as if it were part of the reviewed work.

Reviewing uncommitted work is a legitimate mode — `solo-review` exists for exactly that — so the fix is not simply to diff `base..HEAD` unconditionally.

## Work to do

- Record the tree state at snapshot time next to the two facts already recorded there (`snapshot.at`, `snapshot.head`, `lib/review.js:327-337`): whether the tree was clean, and the paths of modified tracked files when it was not. Read it in the same pass as the diff — a separate read before or after leaves the same gap a caller's own pre-check leaves, which is how the third case above happened.
- Put that fact in the reviewer's prompt in `subject()` (`lib/review.js:1042`) alongside the existing staleness paragraph, and name the direction it fails in: content committed at `HEAD` can be absent from the snapshot because the tree was mid-edit, and uncommitted content can be present although nothing committed it.
- Warn the person running the command when the snapshot is taken over a dirty tree, in the same place the base and reviewer address are printed — the run above gave no signal at all.
- Document the mode in `docs/reference/03-cli.md` § Review: what the snapshot compares, and that a mutation probe in progress rewrites it.

## Out of scope

- Changing the comparison to `base..HEAD`: it would break review of uncommitted work, which is a supported mode.
- Re-snapshotting automatically, waiting for a clean tree, or any form of locking against the author — the snapshot is deliberately one-time (`lib/review.js:322-326`).
- The staleness race itself and its existing wording — this entry adds the missing direction, it does not replace what is there.

## Verification

- With a committed change reverted in the working tree only, the snapshot command reports the dirty tree to the person, and the reviewer prompt names the modified paths; before the fix both are silent.
- A clean tree produces the same snapshot and prompt as today apart from an explicit "tree clean" statement.
- Review of purely uncommitted work still produces the same diff it does now.
- `npm test` stays green.

## Triage — 2026-09-07

- **Track:** L — Spawn, review and command guidance (`lib/review.js`).
- **Priority:** P1. It is a verification prerequisite: while it stands, every isolated review in this backlog can be judged against a diff that omits the change under review.
- **Evidence level:** three live measurements on task `pb-qprep-t20260907-160618`, 2026-09-07, plus source review of `lib/review.js:313-337` and `:1042`. Two of the three produced false `[major]` findings; the third survived a deliberate pre-check of the tree.
- **Next step:** implement as written. The fix is a recorded fact and its wording, not a change to what the snapshot compares — reviewing uncommitted work stays supported.
