# PB-85 · driver-cursor.js's resolveTmux checks PATH only while its own findCursorBin already widens PATH with CURSOR_INSTALL_DIRS, so a Homebrew tmux invisible to a background job's PATH passes doctor but refuses spawn

- **Scope:** `lib/driver-cursor.js`, `lib/spawn.js`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`lib/driver-cursor.js:73` declares `CURSOR_INSTALL_DIRS = ['~/.local/bin', '/opt/homebrew/bin', '/usr/local/bin']`. `findCursorBin()` (`lib/driver-cursor.js:117-127`) walks `PATH` plus those three directories to find the `cursor`/`cursor-agent` binary. `resolveTmux()` (`lib/driver-cursor.js:130-146`) runs `run('tmux', ['-V'], { env })` with no directory widening at all — `PATH` only. Re-verified now with `grep -n` against HEAD cc1aca8: the two functions sit 13 lines apart in the same file and only one of them uses the constant declared for exactly this purpose.

`optionRefusal(options, tool, { util = resolveTmux } = {})` (`lib/driver-cursor.js:499`) is the only injection point that could pass a wider resolver, and its sole call site, `lib/spawn.js:266-267` (`export function optionRefusal(driver, effort, tool) { return driver.optionRefusal({ effort }, tool); }`), never supplies one — production always hits the PATH-only branch.

The asymmetry has a live counterpart in the consumer: ati-agents' `cli/lib/tools.js:95-106` (`KNOWN_UTILS.tmux`) duplicates `minVersion: '3.0'` and searches `PATH` plus its own `INSTALL_DIRS`, and `cli/lib/doctor.js:257` (`reportDriverUtils`) uses that wider search for `doctor`. So a `tmux` installed only under Homebrew or `~/.local/bin`, outside a background job's `PATH`, shows green under `doctor` and refuses under `spawn --harness cursor` — the exact split the ati-agents comment at `cli/lib/tools.js:88-90` says the unified `KNOWN_UTILS` traversal exists to prevent. Notably, `test/promptobus-driver-cursor.test.mjs:249` already stubs a not-found reason as 'not found in PATH or in the known install locations (~/.local/bin)', but that string is hand-written into the stub, not produced by the real `resolveTmux` — today's real refusal (`lib/driver-cursor.js:132-134`) says only 'not found in PATH', confirming no test exercises the real search.

The finder's original framing cited this as ADR-036 non-compliance; that framing is stale. `driver-cursor.js`'s own header comment tracked ADR-036's wording ('the driver names it, resolution and version-checking are the adapter's call') verbatim until commit `2047fd8` ('Untie the three harness drivers from the parent workspace layout', 2026-09-04) deliberately replaced it with 'the name is the driver's job; it does the resolving and version-checking itself at option-refusal — the host does not know about a harness's utilities', confirmed with `git log -S` on both phrases. The package's decoupling from a host adapter for utility resolution was deliberate, not an oversight; only the PATH-only/PATH+dirs asymmetry inside this one file survives that choice as a live bug.

## Work to do

- Reuse `CURSOR_INSTALL_DIRS` (or a small shared 'PATH + extra dirs' helper) inside `resolveTmux`, the same way `findCursorBin` already searches it for the cursor binary, so `doctor` and `spawn --harness cursor` resolve the same tmux.
- Update `resolveTmux`'s not-found reason to name the searched install directories once it actually searches them, matching the wording `test/promptobus-driver-cursor.test.mjs:249` already stubs but the real function does not yet produce.
- Add a test in `test/promptobus-driver-cursor.test.mjs` that exercises the real `resolveTmux` (not a stubbed `util`) against a `tmux` binary placed only under one of `CURSOR_INSTALL_DIRS`, and asserts it resolves.
- Leave `TMUX_MIN_VERSION` duplicated with ati-agents' `KNOWN_UTILS.tmux.minVersion` (both `'3.0'` today) — no shared source, no doc change.

## Out of scope

- Reintroducing a host-adapter dependency for utility resolution (ADR-036's earlier wording) — commit 2047fd8 deliberately removed it, and this entry does not reverse that.
- Merging `TMUX_MIN_VERSION` and ati-agents' `KNOWN_UTILS.tmux.minVersion` into one shared source — both agree today at acceptable manual-sync cost.

## Verification

- A test stubbing a `tmux` binary that exists only under one of `CURSOR_INSTALL_DIRS` (not `PATH`) resolves via `resolveTmux` the same way `findCursorBin` resolves a cursor binary placed there.
- `promptobus spawn --harness cursor --dry-run` no longer refuses when tmux is installed only in `~/.local/bin` or `/opt/homebrew/bin`, matching what `doctor` already reports.
- `npm test` green.
