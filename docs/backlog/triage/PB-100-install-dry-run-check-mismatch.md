# PB-100 · `install --check` and `install --dry-run` each report a different delta from what `install` writes: the drift walk skips the ownership manifest, the dry run lists writes the content filter drops

- **Scope:** `lib/install.js` (`runPlan`, `driftOf`), `test/install.test.mjs`, [guides/install.md](../../guides/install.md)
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`lib/install.js:442-448` builds `manWrite` and folds it into `diskWrites`, but never passes it to the drift walk:

```js
const manWrite = manifestWrite(root, host, plan.prev, selected, plan.owned);
const diskWrites = [...plan.writes, cfgWrite, manWrite];
...
const drifts = driftOf(plan.writes, cfgWrite, selected, saved);   // manWrite is not passed
```

`driftOf` (`lib/install.js:386-405`) walks only the `writes` and `cfgWrite` arguments it receives, so `.promptobus/manifest.json` (`installManifestRel()`) is never compared. Verified now on a sandbox host copied from `test/install.test.mjs`: `install --harnesses claude`, then delete only `.promptobus/manifest.json` - `install --check` prints configured, exit 0; `install --dry-run` on the same tree still lists `would write .promptobus/manifest.json`; a real `install` recreates the file. `.promptobus/hooks/bus.mjs` IS in `plan.writes` and IS drift-checked, so the manifest is the one exempt file. `docs/guides/install.md:89` promises "Report drift. Exit 1 if project files no longer match", and line 102 names the manifest among what the installer writes; no comment or ADR exempts it.

Separately, `lib/install.js:457-461` prints every entry of `diskWrites` under `--dry-run`, while the real write path at `468-476` filters by content (`if (current !== write.text) pending.push(write)`). Verified on a byte-identical tree right after a successful install: `--check` answers configured exit 0, `--dry-run` still lists four `would write` lines, none of which a real install would touch.

The manifest text is stable across repeated installs on an unchanged tree (verified: a second install left it byte-identical), so folding it into the drift walk raises no false drift on a clean tree.

## Work to do

- Pass the manifest into the drift walk: `driftOf([...plan.writes, manWrite], cfgWrite, selected, saved)`, or derive the drift list from `diskWrites` minus `cfgWrite` so a future added write cannot be forgotten the same way. Note in a code comment that this catches an absent or field-changed manifest but not foreign keys inside an existing one, since `manifestWrite` spreads `prev.doc`.
- Decide and document the `--dry-run` behaviour: either filter `diskWrites` by content before printing, so `--dry-run` and `--check` describe the same delta (the reading `--check`'s wording implies), or keep printing the whole plan and reword `docs/guides/install.md`'s `--dry-run` row and the `would write` message so they stop implying a write that will not happen. Pick one; leaving the mismatch undocumented is not an option.
- Extend `test/install.test.mjs:241` (`--dry-run writes nothing; --check reports drift and returns non-zero`): a tree whose only defect is a deleted `.promptobus/manifest.json` must exit 1 from `--check`; a clean tree's `--dry-run` output must agree with `--check` under whichever reading is chosen.

## Out of scope

- Foreign keys inside an existing manifest that manifestWrite's spread of `prev.doc` would silently carry forward - this entry catches an absent or field-changed manifest only.
- Any change to what the installer itself writes on a real `install` - this is a reporting-only fix.

## Verification

- On a sandbox host: `install --harnesses claude`; delete `.promptobus/manifest.json`; `install --check` now exits 1 and names the file.
- On a byte-identical clean tree, `install --dry-run` and `install --check` agree (per whichever reading Work picks).
- `npm test`.
