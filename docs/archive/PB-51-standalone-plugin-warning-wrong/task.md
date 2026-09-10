# PB-51 · `participantPluginDir` warns `null: plugin directory is missing`, names a manifest the host never reads and routes to `promptobus install`, which cannot create it — on every standalone spawn and review

- **Order:** 980
- **Scope:** [02-host](../../reference/02-host.md), `lib/spawn.js`, `lib/review.js`, `src/standalone.ts`
- **Created:** 2026-09-06
- **Dependencies:** PB-44

## Context

`participantPluginDir` (lib/spawn.js:76-85) reads `host.pluginDir()` and interpolates it verbatim into a warning when `host.workspaceRoot()`/`host.pluginManifestRel()` does not exist: `warn(`${dir}: plugin directory is missing or has no .claude-plugin/plugin.json manifest — the participant will have no workspace skills. Run ${host.syncHint()}`)`. The standalone host declares no plugin directory at all — `src/standalone.ts:192 pluginDir: () => null` (typed `string | null` at src/host.ts:230) — so `dir` interpolates as the literal string `null`, and the manifest actually checked is `src/standalone.ts:193 pluginManifestRel: () => path.join('.promptobus', 'plugin.json')`, not the `.claude-plugin/plugin.json` the message names.

Both callers gate on `driver.options.skillsDir` — lib/spawn.js:799 and lib/review.js:449 — `true` for the default Claude driver (lib/driver-claude.js:990) and `false` for cursor/codex (lib/driver-cursor.js:1101, lib/driver-codex.js:502), so this fires on every standalone spawn and review under the default harness.

Confirmed today: `promptobus install --harnesses claude` on a scratch standalone workspace exits 0 and writes only `.promptobus/manifest.json` and `.promptobus/hooks/bus.mjs`; `.promptobus/plugin.json` does not appear afterwards, and `pluginManifestRel()` is read at exactly one call site in the whole tree (lib/spawn.js:81) and written nowhere in `lib/`, `src/` or `bin/` — under this host the named file can never come into existence, so the `Run ${host.syncHint()}` route the message offers cannot fix it, and a repeat `review --dry-run` prints the same warning.

The plan line carries the identical defect: `skillsNote` (lib/spawn.js:895-902) falls through to `not attached — plugin directory is missing` whenever `plan.pluginDir` is `null`, which is exactly the standalone case — asserting a missing directory for a host that never declares one by design. docs/reference/02-host.md:33 already states the design fact plainly ("`pluginDir()` is `null`" for standalone) without saying anything about a warning following from it.

## Work to do

- In `participantPluginDir` (lib/spawn.js:76-85), branch on `dir === null` first and return `null` with no warning — a host that declares no plugin directory is not a misconfiguration and there is no command that changes it.
- Keep the warning only when a host DOES declare a directory whose manifest is absent, and name the path actually checked (`path.join(host.workspaceRoot(), host.pluginManifestRel())`) instead of the hardcoded `.claude-plugin/plugin.json` string.
- Fix `skillsNote` (lib/spawn.js:895-902) to say a plugin-less host ships no workspace-skills plugin, instead of reusing the "plugin directory is missing" wording that asserts a directory that was never declared.
- Extend docs/reference/02-host.md:33 with the consequence: no plugin warning follows from a `null` `pluginDir()`.

## Out of scope

- Whether the standalone host should eventually gain a real plugin directory — this only stops it from being reported as broken for not having one.

## Verification

- A unit test on the standalone host: `participantPluginDir(host)` returns `null` and emits no warning, and the plan's `skillsNote` for that host reads the new no-plugin-host wording rather than "plugin directory is missing".
- `promptobus review ./sub --dry-run` in a standalone workspace prints no plugin warning.

## Triage — 2026-09-07

- **Track:** L — Spawn, review and command guidance.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/spawn.js:76`, `src/standalone.ts:192`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
