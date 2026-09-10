# PB-126 · None of review.js's nine bare git spawnSync calls carries a timeout, one crashes instead of refusing when the spawn itself fails, and spawn.js's git call bypasses run() so it escapes the exec trace

- **Scope:** `lib/review.js`, `lib/spawn.js`, `lib/worktree.js`, `lib/exec.js`, `lib/util.js`
- **Created:** 2026-09-06
- **Dependencies:** PB-50, PB-122
- **Taken:** 2026-09-10

## Context

Confirmed against current HEAD (v0.5.0). Nine bare `spawnSync('git', [...], { encoding: 'utf8' })` calls in `lib/review.js` at lines 862, 879, 884, 889, 960, 972, 979, 981 and 987 — none passes `timeout`, `maxBuffer`, or `-c core.quotePath=false`. The file's own two wrapped helpers, `git()` (`:1114-1119`) and `gitRaw()` (`:1124-1129`), DO set `maxBuffer` (`GIT_MAX_OUTPUT`, or `256 * 1024 * 1024` for the raw diff read) and `core.quotePath=false`, but neither sets a `timeout` either — so no git launch in this file has a ceiling on hang time. Line 981, `const cur = spawnSync(...).stdout.trim();`, chains straight onto `.stdout` with no status check: if the spawn itself fails (`r.error` set, e.g. ENOENT), `r.stdout` is `null`/`undefined` and this throws a `TypeError` instead of refusing.

The repository states the opposite intent elsewhere: `lib/exec.js:8` — "Single entry point for external processes"; `lib/util.js:39-42` — "`spawnSync` has no default at all: without an explicit value a hung hook, npm, or npx stands forever"; and `lib/worktree.js:37-43`'s `gitIn` already sets `maxBuffer: GIT_MAX_OUTPUT` and `timeout: GIT_NET_TIMEOUT_MS` (`lib/util.js:24`, 30 s) for exactly this reason, with a documented exception for calling `spawnSync('git', ...)` directly rather than through `run()` (Windows `.cmd` vs git's native `.exe`).

One correction to the raw framing: `review.js:875-877` carries an explicit comment saying `mergeBase`/`isAncestor`/`headOf` call `spawnSync` directly, not through `git()`/`gitRaw()`, on purpose — those callers want a legal `null`/boolean outcome rather than the `{out}|{refusal}` shape, because a refusal is a legal answer there. A fix should add the missing ceilings and quoting via a shared low-level wrapper (lifting `worktree.js`'s `gitIn`) while preserving each call site's own result shape, not force every site through `git()`/`gitRaw()`'s outcome shape.

Separately, `lib/spawn.js:167-170` (`warnTrackedCursor`) calls `spawnSync('git', ['-C', dir, 'ls-files', '--', '.cursor'], { encoding: 'utf8', timeout: GIT_NET_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT })` directly — it already carries a timeout and maxBuffer, but not `core.quotePath=false`, and unlike `worktree.js`'s `gitIn` it carries no comment justifying the direct `spawnSync` instead of `runProc` (`lib/util.js:47`, which wraps `run()` from `exec.js` and is already used elsewhere, e.g. `worktree.js:374` for npm). Because it bypasses `run()`, this git launch never appends to `PROMPTOBUS_EXEC_TRACE` (`lib/exec.js:120-136`) and is invisible to the sealed-PATH suite gate described at `test/run.mjs:513-565`.

Not already tracked: grepped `docs/backlog` and `docs/archive` for review.js/spawnSync/exec.js/quotePath/warnTrackedCursor — no existing entry covers this.

## Work to do

- Lift `lib/worktree.js`'s `gitIn` into a shared low-level helper (fixed `-c core.quotePath=false`, `GIT_MAX_OUTPUT`, `GIT_NET_TIMEOUT_MS`) and route the nine bare `spawnSync` sites in `lib/review.js` (862, 879, 884, 889, 960, 972, 979, 981, 987) through it, keeping each site's own null/boolean/`{out}|{refusal}` result shaping unchanged.
- Fix line 981's crash risk: check `r.status`/`r.error` before touching `.stdout`.
- Add `timeout: GIT_NET_TIMEOUT_MS` to `git()` and `gitRaw()` (`review.js:1114-1129`), which currently set `maxBuffer` and quoting but no timeout.
- Route `lib/spawn.js:168`'s `warnTrackedCursor` git call through `runProc` (`lib/util.js:47`) instead of bare `spawnSync`, keeping its existing `timeout`/`maxBuffer` and adding `-c core.quotePath=false`, so it appends to `PROMPTOBUS_EXEC_TRACE` and is covered by the sealed-PATH gate.
- CHANGELOG entry under `[Unreleased]`: `promptobus review`'s git reads now have a bounded wait instead of hanging indefinitely on a stuck `index.lock` or network mount, and non-ASCII paths read consistently across all of the command's git calls.

## Out of scope

- Collapsing `mergeBase`/`isAncestor`/`headOf`'s intentional null/boolean return shape into `git()`/`gitRaw()`'s `{out}|{refusal}` shape — `review.js:875-877` documents that difference as deliberate; only the missing ceilings and quoting are in scope.
- `lib/install.js:95`'s bare `spawnSync('git', ...)`, which already carries `timeout: 15_000` — it shares only the missing `quotePath`, a smaller, separate gap.

## Verification

- `npm test` stays green (behaviour-preserving on the happy path).
- A unit test simulating `r.error` on the line-981 call site (e.g. by stubbing `spawnSync` to return `{ error: new Error('ENOENT') }`) shows a refusal instead of a thrown `TypeError`.
- `PROMPTOBUS_EXEC_TRACE` (set per `test/run.mjs:144`) contains a line for the `warnTrackedCursor` git launch after the fix, where it previously had none.

## Triage — 2026-09-07

- **Track:** L — Spawn, review and command guidance.
- **Priority:** P1.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/exec.js:8`, `lib/util.js:39`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Set bounded process calls and classify spawn failure; a shared git helper is optional. Do not extract one unless it preserves each caller environment, quoting, byte/text and refusal contract.
