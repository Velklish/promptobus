# PB-120 · `DriverOptions.effortMinVersion` is populated with one entry that `optionRefusal` never reads, and `driver-cursor.js`'s `resolveTmux` call passes a `fresh` option the function does not accept

- **Order:** 180
- **Scope:** `lib/driver-claude.js`, `lib/driver-cursor.js`, `src/driver.ts`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

Verified against HEAD (v0.5.0). (1) `src/driver.ts:280` types `effortMinVersion?: Record<string, string>` ("Minimum harness version per effort level"); `lib/driver-claude.js:965` populates it as `{ ultracode: ULTRACODE_MIN_VERSION }`. But `optionRefusal` (`:762-767`) opens `if (effort !== 'ultracode') return null;` and compares `tool.version` against the module-level `ULTRACODE_MIN_VERSION` constant directly — it never reads `effortMinVersion` at all, whether via a parameter or via the `claudeDriver.options` object it belongs to. `grep -rn effortMinVersion lib src` returns exactly the declaration and the type — nothing else reads the map. A second entry (e.g. `max: '2.1.300'`) would refuse nothing: `optionRefusal` still returns `null` for `effort === 'max'`. (2) `lib/driver-cursor.js:506`: `const tmux = util(TMUX_UTIL, { fresh: true });` calls `resolveTmux(_name, { env = process.env } = {})` (`:130`) — the destructured second argument has no `fresh` field, and `_name` is unused. `grep -n -i cache lib/driver-cursor.js` finds nothing: there is no cache anywhere in the module for `fresh` to bypass, so the option is inert and every option refusal shells out to `tmux -V` unconditionally regardless of the flag. Not tracked: `grep -rniE 'effortMinVersion|resolveTmux|fresh.*true' docs/backlog docs/archive` finds nothing. The only related archived item, `PB-15.1-host-tool-bin-version-undeclared`, touches `optionRefusal`/`ULTRACODE_MIN_VERSION` for a different concern (an undeclared bin version) and does not discuss the dead map lookup or the `fresh` flag.

## Work to do

- In `lib/driver-claude.js`, either make `optionRefusal` look up `claudeDriver.options.effortMinVersion?.[effort]` and build the refusal message from whatever level and version it finds, so a second entry actually works; or — since only one effort is gated today — collapse the field to a single scalar (e.g. `ultracodeMinVersion: string` in `src/driver.ts`, dropping the `Record<string, string>` shape) so the type stops advertising a lever nothing pulls generically.
- Update `src/driver.ts:280`'s doc comment to match whichever shape is kept.
- In `lib/driver-cursor.js`, drop the dead `{ fresh: true }` argument from the `util(TMUX_UTIL, { fresh: true })` call and the unused `_name` parameter from `resolveTmux`.

## Out of scope

- Adding an actual cache for `resolveTmux` — nothing today asks for tmux-version caching; this only removes a flag that documents a behaviour that does not exist.
- Any other driver's `optionRefusal` (Codex has none; Cursor's own version gate, `PROVEN_CURSOR_VERSION`, is a separate, already-generic check untouched by this entry).

## Verification

- A test lifting `--effort ultracode` on an old binary still refuses (unchanged behaviour); if the generic-lookup fix is taken, a fixture adding a second `effortMinVersion` entry and constraining that effort on an old binary now also refuses — currently it would not.
- `grep -n 'fresh' lib/driver-cursor.js` finds no remaining reference once the flag is dropped.
- `npm test` stays green.

## Triage — 2026-09-07

- **Track:** D — Harness registries and Cursor / Claude drivers.
- **Priority:** P3.
- **Evidence level:** source/definition review at `1e0401a`, including `src/driver.ts:280`, `lib/driver-claude.js:965`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.

## Returned to the queue, 2026-09-12

**The return condition has fired:** blockers `PB-85` and `PB-93` are archived, so the scoped driver-contract cleanup the condition names can be scheduled.
