# PB-129 · installWorktreeDeps and runRepoGenerator run the same run-log-classify sequence by hand in two files, and the copy has already drifted in its ENOENT wording

- **Scope:** `lib/worktree.js`, `lib/spawn.js`, `lib/util.js`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`lib/worktree.js:371-389` (`installWorktreeDeps`) and `lib/spawn.js:967-1004` (`runRepoGenerator`) run the identical twelve-statement sequence: `const started = Date.now();` … `const ms = Date.now() - started;`, a log write in a `try { writeFileSync(...) } catch {}` (character-identical template: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`), then a three-way classification — ENOENT / `procTimedOut(r)` / generic exit code with `lastLines` tail. `lib/spawn.js:993-994` and `:998-1000` name the copy in their own comments: "Same place and same reason as the `npm ci` log" and "Same shape and same reason as the `node_modules` ignore check after `npm ci`" — the duplication is noticed, not accidental, and left in place. One genuine wording drift survives re-verification: the ENOENT branch reads `'npm not found in PATH'` in `worktree.js:381` versus `` `was not found in PATH (${declared.argv[0]})` `` in `spawn.js:1000`. (The exit-code-tail formatting itself is NOT drifted — both expressions were re-run with the same inputs and produce byte-identical strings in every case; that part of the original finding does not hold and is not carried forward.) Both functions are exercised only from `test/promptobus-spawn.test.mjs` (`installWorktreeDeps` at line 1146, `runRepoGenerator` at line 1268) — `test/promptobus-worktree.test.mjs` exists but does not call `installWorktreeDeps` at all, so the coverage claim in the original finding named one file too many.

## Work to do

- Extract a `runLogged(argv, { cwd, timeout, logPath, exec })` helper into `lib/util.js` beside `runProc`/`procTimedOut`/`lastLines`, returning `{ status, ms, logPath, why }` with the ENOENT/timeout/exit-code classification unified in one place.
- Have `installWorktreeDeps` and `runRepoGenerator` call it and add only their own domain fields on top (`ignored`, `command` for the former; `argv`, `dirt` for the latter).
- Reconcile the one real wording difference (the ENOENT message) as part of the merge — pick one wording and note the choice, rather than silently keeping either verbatim.
- Keep `test/promptobus-spawn.test.mjs:1146` and `:1268` passing unchanged in behavior (message text aside) since they exercise both call sites already.

## Out of scope

- No new failure classes are added (killed process, full disk on the log write) — this is a mechanical extraction of the existing three-way classification, not a redesign of it.
- The presentation halves (`sayWorktreeDeps`, `sayRepoSkills`) are not touched; only the run-log-classify sequence that feeds them.

## Verification

- `npm test` stays green, in particular `test/promptobus-spawn.test.mjs` around lines 1146 and 1268 (the ENOENT and generic-failure paths for both `installWorktreeDeps` and `runRepoGenerator`).
- `grep -n "const started = Date.now" lib/worktree.js lib/spawn.js` shows one occurrence total (in `lib/util.js`) instead of one per caller.

## Deferred

- **Deferred:** 2026-09-07
- **Reason:** A shared process helper would overlap the process-boundary and launch fixes.
- **Return condition:** PB-50, PB-122, PB-126 and PB-83 are accepted, and the remaining two call sites have demonstrably identical contracts.

## Triage — 2026-09-07

- **Track:** X — Deferred structural work.
- **Priority:** P3.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/worktree.js:371`, `lib/spawn.js:967`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
