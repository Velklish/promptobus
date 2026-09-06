# PB-113 · live-canary.mjs was never re-anchored after promptobus's extraction into its own package — its release verdict is named after a `sync --no-global` run that never happens (the only CLI call it makes is `--version`), it cites two files that don't exist in this repository, and it imports `resolveToolBin` twice, leaving one binding dead

- **Scope:** `scripts/live-canary.mjs`, `test/sandbox.mjs`, `test/tmpdir-sweep.test.mjs`, `scripts/audit-public.mjs`
- **Created:** 2026-09-06
- **Dependencies:** none

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
