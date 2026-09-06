# PB-91 · models calibrate --write always merges into the lowest-precedence user overlay and reports success even when a layer above it overrides every rating just written

- **Scope:** `lib/models.js` (`calibrateCommand`, `userLayer`), `lib/model-routing/catalog.js` (`applyOverlayToTuples`), `lib/model-routing/calibrate.js` (`ratingLine`), [reference/03-cli.md](../../reference/03-cli.md) § Commands, [reference/02-host.md](../../reference/02-host.md) § The writable layer, `test/model-routing-calibrate.test.mjs`. Related: ADR-004 § Host contract (`docs/adr/adr-004-subscription-balance.md:204`), ADR-005 (`docs/adr/adr-005-ten-point-scale-absolute-bands-calibrate.md`), PB-32 (archived — added the shadow warning to `strategy --set`), PB-37 (archived — added `models calibrate`)
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`calibrateCommand`'s write target is fixed to the layer whose id is `user` (`userLayer(host)`, `lib/models.js:668-677`), which ADR-005 deliberately picked as NOT the writable layer — but it is also, in both shipped hosts, the LOWEST-precedence overlay: `src/standalone.ts:163-174` declares `overlays: [{id:'user',...}, {id:'workspace', writable:true}]`, and `cli/lib/promptobus/ati-host.js:76-84` (the ati-agents host) declares three, in order `user`, then the `ati` policy layer, then the writable `workspace`.

`applyOverlayToTuples` (`lib/model-routing/catalog.js:501-519`) merges each layer's `ratings[tupleId]` over the accumulated tuple PER RATING KEY (`ratings: { ...tuple.ratings, ...patchedRatings }`, line 515), applied in declared layer order inside `loadCatalog` (line 606). So any layer above `user` that names the same tuple and the same rating key wins over what `calibrate --write` just wrote.

`calibrateCommand` never reads what is above its target before writing: it computes `shipped`/`merged`/`report`, writes at line 751, and reports success unconditionally — `ok('merged N rating override(s) into overlay …')` (lines 785-786); under `--json` the document (lines 759-766) carries only `{layer, path, tuples, applied}`, with no awareness of layers above `user`.

The sibling command already carries exactly the guard this one lacks. `strategy --set`'s handler reads the layers above its OWN target before writing (`lib/models.js:588-590`, `const above = declared.slice(...).filter(...)`) and warns naming the shadowing layer after the write (`lib/models.js:595-598`). ADR-004 § Host contract (`docs/adr/adr-004-subscription-balance.md:204`, "A host that marks a layer other than the highest-precedence one writable creates a trap... so `models strategy --set` warns when what it just wrote is shadowed") and `docs/reference/02-host.md:59` name this exact trap by name — and `calibrate --write`'s target is IN it by construction, since ADR-005 fixed that target as the bottom layer on purpose.

Reproduced live (using the `workspace()` fixture builder already in `test/model-routing-calibrate.test.mjs:333`, run once as a throwaway script and discarded — no repository file was left changed): with a `workspace` overlay of `{schemaVersion:2, ratings:{'claude-sonnet-xhigh':{speed:9,quotaCost:9}}}`, `models calibrate --write --yes` exits 0, reports `write: {layer:"user", tuples:2, applied:true}`, and writes `{speed:1,quotaCost:4}` to the `user` file — but `loadCatalog` for that tuple still resolves to `{quality:7,speed:9,quotaCost:9}`: the `workspace` layer's rating is what actually took effect, silently.

The one partial signal that exists is not a guard: `ratingLine` prints `catalog N, your overlay M` from the MERGED stack (`lib/model-routing/calibrate.js:383-386`) — in this run, `catalog 5, your overlay 9` — so the number 9 is visible, but the label "your overlay" is actively wrong (the 9 came from `workspace`, not from the `user` file the command is about to write), it names no layer, and it is absent from `--json` entirely.

Nothing downstream catches it either: `models validate`'s shadow checks (`lib/model-routing/validate.js:582-621`) cover only `allow`/`deny` rules, and its `referenceChecks` (lines 521-528) only assert that a rated tuple id exists in the merged catalog, never that two layers rate the same id.

Reach today is narrow and needs a hand-edited `workspace` overlay or a policy layer that rates tuples — both lawful under the overlay grammar — since nothing the tool itself writes today puts `ratings` above `user` (`strategy --set` writes `defaults` only; the ati-agents `ati` policy layer carries `deny.flags` alone).

## Work to do

- Before the write in `calibrateCommand`, mirror `strategy --set`'s guard (`lib/models.js:588-590`) but per rating key rather than per tuple (`applyOverlayToTuples` merges key by key, so a layer naming only `speed` shadows only `speed`): read the layers above `user` in `host.routingPaths().overlays`, and for each `(tupleId, ratingKey)` pair about to be written, check whether a higher layer's `ratings[tupleId]` names that same key.
- After a successful write, when that set is non-empty, `warn` naming the highest such layer and the shadowed `(tuple, rating)` pairs, matching the phrasing `strategy --set` already uses.
- Add the same information to the `--json` document as a field, e.g. `write.shadowedBy: [{layer, tuple, ratings}]`, rather than only as console prose.
- Fix `ratingLine` (`lib/model-routing/calibrate.js:383-386`) to name which layer an "overlay" value actually came from, since it currently reads the merged stack and can name a layer other than the one `--write` is about to touch.
- Document the warning in `docs/reference/03-cli.md` § Commands beside the `--write` paragraph (line 100), the way line 110 documents `strategy --set`'s warning, and add a note to `docs/reference/02-host.md` § The writable layer (around line 59) that the `user`-layer exception carries the same shadow warning.
- Update `CHANGELOG.md`.

## Out of scope

- Changing `calibrate --write`'s target away from `user` — ADR-005 fixed that deliberately and this entry does not reopen it.
- `models validate`'s `allow`/`deny` shadow checks — a different, already-covered rule.

## Verification

- A new case in `test/model-routing-calibrate.test.mjs`, using the existing `workspace()` helper: a higher layer rating the same tuple/key as the calibration report, asserting the warning fires and `write.shadowedBy` is populated; a case with no overlap asserting silence.
- `npm test` stays green.
