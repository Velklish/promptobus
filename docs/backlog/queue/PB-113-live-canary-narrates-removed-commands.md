# PB-113 · live-canary.mjs was never re-anchored after promptobus's extraction into its own package — its release verdict is named after a `sync --no-global` run that never happens (the only CLI call it makes is `--version`), it cites two files that don't exist in this repository, and it imports `resolveToolBin` twice, leaving one binding dead

- **Order:** 660
- **Scope:** `scripts/live-canary.mjs`, `test/sandbox.mjs`, `test/tmpdir-sweep.test.mjs`, `scripts/audit-public.mjs`
- **Created:** 2026-09-06
- **Dependencies:** PB-69

## Context

All three sub-findings re-verified now against current HEAD (v0.5.0, file unchanged since the finders' snapshot).

1. Unfalsifiable verdict: `grep -n "cli(\[" scripts/live-canary.mjs` returns exactly one call, line 273: `cli(['--version'])`. `lib/cli.js:19`'s `SUBCOMMANDS` is `spawn, review, models, status, done, dismiss, history, prune, guard, warden, mcp, install, uninstall` — no `sync`, no `doctor`. Yet the file's header (lines 14-15, 24-33), step banner (140), snapshot commentary (150, 179, 190, 230-248, 254, 271) and the check itself (295: `check('canary: sync --no-global wrote nothing outside the workspace directory', syncDiff.length === 0, ...)`) all narrate a `sync --no-global` and `doctor` run that never executes. The ~90-line home-snapshot apparatus (`homeSnapshot`/`homeDiff` plus `CLAUDE_PLUGINS`/`KNOWN_MARKETPLACES`/`INSTALLED_PLUGINS`/`PLUGIN_CACHE`/`CLAUDE_SETTINGS`) guards a verdict that cannot fail, because nothing that could touch those doors has run before it. The bare clone at lines 153-154 (`git clone --bare`) is unused for this purpose too — its result `mirrored` is only referenced at that line and at the cleanup line 427.
2. Dangling references: `scripts/live-canary.mjs:6, 19, 68` reference `release-gates.mjs` and `base.js` as if they exist in this repository. `ls scripts/` lists only `audit-public`, `canary-runs`, `live-canary`, `live-codex`, `live-cursor`, `live-e2e`, `live-mixed` — no `release-gates.mjs`; `find . -iname base.js` (excluding `node_modules`) finds nothing. `test/tmpdir-sweep.test.mjs:104` itself already asserts "release-gates.mjs is not in this repository".
3. Dead import: `scripts/live-canary.mjs:46` statically imports `{ writeHostConfig, resolveToolBin }` from `../test/sandbox.mjs`; only `writeHostConfig` is used (line 162). `resolveToolBin` is re-imported dynamically at line 207 inside a `try { ... } catch { claudeBin = null; }` block that downgrades a real resolution failure to a silent null, instead of surfacing it the way the static import would.

## Work to do

- Decide what Step 1 verifies now that this package ships no `sync`/`doctor` — either drive `promptobus install` for real and keep the home-snapshot guarantee meaningful, or delete the snapshot apparatus, the bare clone, and the sync/doctor prose, and rename the verdict to what `--version` actually proves
- Rewrite the `release-gates.mjs`/`base.js` comments (lines 6, 19, 68) to name what plays those roles today (`scripts/audit-public.mjs` / `npm run audit` for packaging), or state that the concept did not survive extraction
- Delete the dynamic re-import of `resolveToolBin` at line 207 and use the static binding from line 46 (or drop it from the static import if the dynamic path is kept deliberately)

## Out of scope

- Rewriting the other live-* scripts (`live-codex.mjs`, `live-cursor.mjs`, `live-e2e.mjs`, `live-mixed.mjs`), which already import `resolveToolBin` once, statically
- Adding a real `sync`/`doctor` command to the CLI — this only fixes the canary's own narration to match commands that exist

## Verification

- `grep -n "sync\|doctor" scripts/live-canary.mjs` names only commands present in `lib/cli.js`'s `SUBCOMMANDS`, or the sync/doctor prose is gone entirely
- `grep -n "release-gates.mjs\|base.js" scripts/live-canary.mjs` returns nothing, or names files that exist in this repository
- `grep -n resolveToolBin scripts/live-canary.mjs` shows exactly one import site
- `npm run audit` (or whichever canary script remains) still passes

## Consolidated evidence from PB-92

### PB-92 · scripts/live-canary.mjs still speaks of sync and doctor after the standalone extraction removed both from this package, leaving one verdict named for a command that no longer exists and a repository clone nothing in the script reads

- **Scope:** `scripts/live-canary.mjs`
- **Created:** 2026-09-06
- **Recorded dependencies:** none

### Context

Commit `9f8c304` ("PB-suite: adapt the transferred suite to the standalone host", 2026-09-04) removed the two calls this package's ancestor made — `cli(['sync', '--no-global'])` and `cli(['doctor'])` — together with their own verdicts, and updated `STEPS` (lines 88-93) to describe only what remains: "tarball installed... answers --version" and "the snapshot before install is compared after --version and at the end of the run". `grep -n "cli\(\[" scripts/live-canary.mjs` today returns exactly one hit, `cli(['--version'])` at line 273 — the only child `promptobus.js` process the script runs anywhere.

What that commit did not update:

- Line 295: the surviving verdict is still named `'canary: sync --no-global wrote nothing outside the workspace directory'`, and its detail string (line 297) tells a reader to run `claude plugin marketplace remove <id>` — a cleanup for a command this package has never had (`node bin/promptobus.js help` lists `review/spawn/models/status/done/prune/dismiss/history/install/uninstall/mcp/warden/guard`; there is no `sync` and no `doctor` in the `lib/cli.js` switch). This check is not blind, only misnamed: the `finally` block (line 357, `'the person home: nothing sync writes changed over the whole run'`) compares the SAME `homeBefore` against `homeAfterRun` over the whole run — a strict superset of what line 295 covers, over the same four snapshot fields — so nothing is left unwatched, only mislabeled.
- Lines 153-154: `baseOrigin` is still cloned every run (`git clone --bare ...`) and never consumed — `mirrored.status` is never read, and `baseOrigin` itself appears again only at the `rmSync` teardown (line 427). Before the extraction it fed the layout lock the old flow wrote (`base: { repo: baseOrigin, ref: branch }`); the adaptation commit replaced that plant with `writeHostConfig(ws, ...)` (line 163) and left the clone behind.
- Stale prose in comments: lines 14-15 ("a temporary workspace, package install, `sync` and `doctor` from it"), lines 18-21 and 150 ("the workspace gets its base as a clone of THIS branch... `sync` will `git clone` it for real"), the section banner at line 140 ("Step 1: clean workspace, install, sync and doctor"), line 190 ("would send `sync` and `doctor` without it"), and the note label at line 271 ("home snapshot before sync").

None of this changes what the canary actually protects — the `finally` verdict is the real gate and is unaffected — but the report a person reads before cutting a tag names a command and a cleanup step that belong to an earlier shape of this package, and a git clone that nothing checks sits in the run's disk footprint for no reason.

### Work to do

- Delete the verdict at lines 293-298 (`homeAfterSync = homeSnapshot()`, `syncDiff`, and the `check('canary: sync --no-global ...')` call) — the `finally` verdict already covers the same fields over a superset of the interval. Rename the note at line 271 from "home snapshot before sync" to "home snapshot before the run".
- Delete the `baseOrigin` clone (lines 153-154) and its `rmSync` (line 427) — nothing consumes `mirrored` or `baseOrigin` since `writeHostConfig` replaced it.
- Fix the stale prose in comments at lines 14-15, 18-21, 140, 150, 190 to describe what the script now actually does (tarball install, `--version`, the home snapshot compare) — `STEPS` (lines 88-93) is already correct and needs no change.

### Out of scope

- Adding back an equivalent layout-verification step under a command this package actually has — that is a larger call belonging to the owner, not a cleanup of stale references.
- Any change to the `finally` home-comparison verdict itself, which is correct and unaffected.

### Verification

- `node scripts/live-canary.mjs` runs to completion with unchanged pass/fail verdicts on every remaining check, and its output no longer contains a line naming `sync` or `doctor`.
- `grep -n "sync\|doctor" scripts/live-canary.mjs` returns no hits after the pass.

## Triage — 2026-09-07

- **Track:** Q — Verification, shared execution and documentation.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/cli.js:19`, `scripts/live-canary.mjs:6`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Includes PB-92. Re-anchor the existing canary to the checks it actually runs; keep the meaningful whole-run home-snapshot check. Adding a new install canary is a separate scope decision. Remove only the redundant step and proven-unused clone/import.
