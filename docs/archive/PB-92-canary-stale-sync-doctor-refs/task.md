# PB-92 · scripts/live-canary.mjs still speaks of sync and doctor after the standalone extraction removed both from this package, leaving one verdict named for a command that no longer exists and a repository clone nothing in the script reads

- **Scope:** `scripts/live-canary.mjs`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Commit `9f8c304` ("PB-suite: adapt the transferred suite to the standalone host", 2026-09-04) removed the two calls this package's ancestor made — `cli(['sync', '--no-global'])` and `cli(['doctor'])` — together with their own verdicts, and updated `STEPS` (lines 88-93) to describe only what remains: "tarball installed... answers --version" and "the snapshot before install is compared after --version and at the end of the run". `grep -n "cli\(\[" scripts/live-canary.mjs` today returns exactly one hit, `cli(['--version'])` at line 273 — the only child `promptobus.js` process the script runs anywhere.

What that commit did not update:

- Line 295: the surviving verdict is still named `'canary: sync --no-global wrote nothing outside the workspace directory'`, and its detail string (line 297) tells a reader to run `claude plugin marketplace remove <id>` — a cleanup for a command this package has never had (`node bin/promptobus.js help` lists `review/spawn/models/status/done/prune/dismiss/history/install/uninstall/mcp/warden/guard`; there is no `sync` and no `doctor` in the `lib/cli.js` switch). This check is not blind, only misnamed: the `finally` block (line 357, `'the person home: nothing sync writes changed over the whole run'`) compares the SAME `homeBefore` against `homeAfterRun` over the whole run — a strict superset of what line 295 covers, over the same four snapshot fields — so nothing is left unwatched, only mislabeled.
- Lines 153-154: `baseOrigin` is still cloned every run (`git clone --bare ...`) and never consumed — `mirrored.status` is never read, and `baseOrigin` itself appears again only at the `rmSync` teardown (line 427). Before the extraction it fed the layout lock the old flow wrote (`base: { repo: baseOrigin, ref: branch }`); the adaptation commit replaced that plant with `writeHostConfig(ws, ...)` (line 163) and left the clone behind.
- Stale prose in comments: lines 14-15 ("a temporary workspace, package install, `sync` and `doctor` from it"), lines 18-21 and 150 ("the workspace gets its base as a clone of THIS branch... `sync` will `git clone` it for real"), the section banner at line 140 ("Step 1: clean workspace, install, sync and doctor"), line 190 ("would send `sync` and `doctor` without it"), and the note label at line 271 ("home snapshot before sync").

None of this changes what the canary actually protects — the `finally` verdict is the real gate and is unaffected — but the report a person reads before cutting a tag names a command and a cleanup step that belong to an earlier shape of this package, and a git clone that nothing checks sits in the run's disk footprint for no reason.

## Work to do

- Delete the verdict at lines 293-298 (`homeAfterSync = homeSnapshot()`, `syncDiff`, and the `check('canary: sync --no-global ...')` call) — the `finally` verdict already covers the same fields over a superset of the interval. Rename the note at line 271 from "home snapshot before sync" to "home snapshot before the run".
- Delete the `baseOrigin` clone (lines 153-154) and its `rmSync` (line 427) — nothing consumes `mirrored` or `baseOrigin` since `writeHostConfig` replaced it.
- Fix the stale prose in comments at lines 14-15, 18-21, 140, 150, 190 to describe what the script now actually does (tarball install, `--version`, the home snapshot compare) — `STEPS` (lines 88-93) is already correct and needs no change.

## Out of scope

- Adding back an equivalent layout-verification step under a command this package actually has — that is a larger call belonging to the owner, not a cleanup of stale references.
- Any change to the `finally` home-comparison verdict itself, which is correct and unaffected.

## Verification

- `node scripts/live-canary.mjs` runs to completion with unchanged pass/fail verdicts on every remaining check, and its output no longer contains a line naming `sync` or `doctor`.
- `grep -n "sync\|doctor" scripts/live-canary.mjs` returns no hits after the pass.
