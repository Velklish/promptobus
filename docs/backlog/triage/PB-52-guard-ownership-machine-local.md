# PB-52 · A guard hook group is recognised as ours by this machine's absolute bin path, so a checkout without the gitignored manifest gains a second Stop/SessionStart guard that neither install nor uninstall can remove

- **Scope:** `lib/install.js`, `src/hooks.ts`, `src/standalone.ts`, `docs/guides/install.md`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`isOwnedGroup` (lib/install.js:156-167) recognises a guard-event group (`Stop`/`SessionStart`) as ours only when its command equals this run's own `guardCommand`, or contains `promptobus guard` AND `ctx.binNeedle` (lines 164-166). `ctx.binNeedle` is `host.layoutBinPath()` (install.js:350) — this machine's absolute bin path — and `guardHookCommand` (src/hooks.ts:75) bakes `"<nodePath>" "<layoutBinPath>" promptobus guard`, with `nodePath` defaulting to `process.execPath` (src/standalone.ts:135); both are machine-local. The fallback that would otherwise catch a foreign command is the id set `readOwned` returns (install.js:268-278) from `.promptobus/manifest.json` (`installManifestRel`, src/standalone.ts:195) — a file inside the store, gitignored (`.promptobus/` in .gitignore line 3) — while `.claude/settings.json` is a project file meant to be committed.

Reproduced today: install in a scratch project (`promptobus install --harnesses claude`), then simulate a teammate's fresh checkout by rewriting the baked node/bin paths in `.claude/settings.json` to a foreign machine's strings and deleting `.promptobus/` (which a fresh clone never has), then `install --harnesses claude` again. Result: `Stop` and `SessionStart` each end up with 2 hook groups — the stale one still spawning the foreign `"<other node>" "<other bin>" promptobus guard` command. `PostToolUse` stays at 1 group because its ownership id is keyed by the matcher, not by the command. `install --check` afterwards prints `configured` and exits 0 — no drift reported — and `uninstall` removes only the group it owns, leaving the foreign guard command in `.claude/settings.json` permanently.

docs/guides/install.md:106 states "Promptobus recognises its own records by a stable command and matcher" — false for the guard events specifically, since the guard command bakes an absolute machine path that is not stable across machines by construction.

## Work to do

- Recognise a guard group by the shape of its command (the `promptobus guard` argv, optionally with `--role`/`--task`/`--home`) rather than requiring this machine's bin path; keep the bin-path needle as extra confirmation, never as a requirement, so a foreign machine's guard is replaced instead of duplicated and `uninstall` can strip it.
- Alternatively (or in addition): move the ownership manifest out of the gitignored store to a file committed beside `promptobus.json`, so ownership travels with the hooks it describes across checkouts.
- Correct docs/guides/install.md:106 to describe what actually identifies a guard record instead of the unqualified "stable command and matcher" claim.

## Out of scope

- What identifies a `PostToolUse`/bus-feedback group — that path is already keyed by the matcher and is unaffected by this.

## Verification

- A test: an existing `.claude/settings.json` holding a guard command with foreign node/bin paths and no manifest ends, after `install --harnesses claude`, with exactly one `Stop` group and one `SessionStart` group; `uninstall` from that state leaves no `promptobus guard` command in the file.
