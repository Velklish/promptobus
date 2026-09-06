# PB-154 · The Cursor hook-event gate validates a constant that can never be wrong, and `install --check` never reads the manifest it promises to detect drift in

- **Scope:** `lib/install.js` (`assertCursorHookEvents`, `mergeHookEvents`, `driftOf`, `manifestWrite`), `test/install.test.mjs`, [guides/install.md](../../guides/install.md)
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Two independent gaps in lib/install.js, both confirmed against the current tree.

**The Cursor event-name gate checks the wrong object.** install.js:341 `if (name === 'cursor') assertCursorHookEvents(ourEvents);` validates `ourEvents`, and for Cursor that is always the literal `cursorEvents()` returns (install.js:206-208): `{ stop: [{ command: guardCmd }] }`. That value can never contain an unknown key, so the gate can never fire. What actually gets written to `.cursor/hooks.json` is the *merged* object, `mergeHookEvents(existing.doc.hooks, ourEvents, ctx)` (install.js:342), which keeps every group from the project's existing file that the merge doesn't own (install.js:180-186). The module's own comment names the stake (install.js:25-26): 'An unknown name in `.cursor/hooks.json` silently disables every hook in the file.' So a project whose `.cursor/hooks.json` already carries an event name outside `CURSOR_HOOK_EVENTS` installs cleanly, prints `✔ configured`, and ships a file in which the just-written `stop` guard is dead. The existing test (`test/install.test.mjs:277-284`, 'cursor event-name gate matches the driver list…') only calls `assertCursorHookEvents` directly with hand-built input, so it never runs `install()` against a pre-existing `hooks.json` carrying a foreign key, and cannot see this.

**`--check` never looks at the ownership manifest.** install.js:448 `const drifts = driftOf(plan.writes, cfgWrite, selected, saved);` hands `driftOf` only the hook-file writes and the `promptobus.json` write. The manifest write, `manWrite = manifestWrite(root, host, plan.prev, selected, plan.owned)` (install.js:442), is folded into `diskWrites` for the real install (install.js:443) but is never passed into `driftOf`, so a `--check` run cannot see whether `.promptobus/manifest.json` still matches what was last written. docs/guides/install.md:89 promises: '`--check` | Report drift. Exit 1 if project files no longer match.'; :102 names the manifest as exactly the file where 'Ownership ids are stored' (`installManifestRel()`). Deleting `.promptobus/manifest.json` after an install and re-running `install --check` still prints `configured` and exits 0. `prevIds` (install.js:332) reads that manifest to strip an owned hook group whose command text has since changed; without it, only the command-needle fallback (install.js:156-169) still recognizes an owned group, and that stops matching the moment the Node path, bin path, or command text changes.

## Work to do

- Call `assertCursorHookEvents` on the merged `hooks` object produced at install.js:342 (the result of `mergeHookEvents`), not on `ourEvents`, so an unknown key already present in the project's file is caught before it is written back out.
- Pass `manWrite` into `driftOf` at install.js:448 alongside `cfgWrite` (or fold it into the same list the hook writes already travel in), so a deleted or edited `.promptobus/manifest.json` shows up as drift.
- Extend `test/install.test.mjs`: one case seeding `.cursor/hooks.json` with an event key outside `CURSOR_HOOK_EVENTS` before calling `install()`, asserting the outcome is no longer a silent `configured` over a dead guard; one case deleting `.promptobus/manifest.json` after an install and asserting `--check` exits 1.

## Out of scope

- Deciding whether an unknown key found in someone else's `.cursor/hooks.json` should refuse the install outright or warn and continue — that's a policy call this finding does not settle; the fix here is only about which object the existing gate checks.
- Any other coverage gap in `--check` beyond the manifest — `driftOf`'s handling of `plan.writes` and `cfgWrite` is unaffected.

## Verification

- A project with `.cursor/hooks.json` pre-seeded with an event name outside `CURSOR_HOOK_EVENTS`: `install --harnesses cursor` no longer reports `configured` while leaving that key merged in untouched.
- Install, delete `.promptobus/manifest.json`, then `install --check`: exit code 1 with a `drift:` line naming the manifest, matching the promise at docs/guides/install.md:89.
