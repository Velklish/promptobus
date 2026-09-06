# PB-46 · ROADMAP's goals 4 and 6 hand-copy catalog figures that have since drifted, so the document states 45 tuples and floors 3/5 where the shipped code now carries 48 tuples and floors 5/9

- **Order:** 730
- **Scope:** `docs/ROADMAP.md`, `models/catalog.json`, `lib/model-routing/catalog.js`, `test/promptobus-package.test.mjs`, `test/model-routing-catalog.test.mjs`
- **Created:** 2026-09-06
- **Dependencies:** PB-37.1

## Context

`docs/ROADMAP.md:10` (goal 4) reads "`models/catalog.json` (45 rated tuples)"; `node -e 'console.log(require("./models/catalog.json").tuples.length)'` prints `48` on the current tree. `docs/ROADMAP.md:12` (goal 6) reads "quality floors are `qualityFloor: { worker: 3, reviewer: 5 }`"; `lib/model-routing/catalog.js:89` reads `qualityFloor: Object.freeze({ worker: 5, reviewer: 9 })`. `PB-37` (`docs/archive/PB-37-adr-005-ten-point-scale-absolute-bands-calibrate`) changed the floors to 5/9 and rebuilt the catalog without touching either ROADMAP sentence. Neither is a dated snapshot the way the "Measured on 2026-09-05/09-06" sentences elsewhere in the same two goals are — both state a present-tense fact about the shipped file (`45 rated tuples`) or object (`qualityFloor: { worker: 3, reviewer: 5 }`), and both are simply wrong today.

A precedent for the fix already exists in this repository: `docs/archive/PB-20.2-overview-version-line-has-no-gate` closed by adding a check in `test/promptobus-package.test.mjs:366-367` — `check('docs/reference/01-overview.md names the version package.json carries', overviewVersion === pkg.version, ...)` — a mechanical read of a hand-written prose number against a code-derived one, red on drift. No equivalent exists yet for the tuple count or the quality floors: `grep -rn "tuple\|qualityFloor\|quality floor" docs/backlog docs/archive` turns up nothing tracking this pair.

## Work to do

- Fix `docs/ROADMAP.md:10` to `48 rated tuples`.
- Fix `docs/ROADMAP.md:12` to `qualityFloor: { worker: 5, reviewer: 9 }`.
- Add a check — in `test/promptobus-package.test.mjs` beside the existing version-line check, or in `test/model-routing-catalog.test.mjs` next to the catalog's own invariant tests — that reads `models/catalog.json`'s `tuples.length` and the default `qualityFloor` from `lib/model-routing/catalog.js`, and fails when either stops matching the numbers written into `docs/ROADMAP.md`.

## Out of scope

- The dated "Measured on <date>" sentences in the same two goals — those describe a point-in-time run, not the shipped file, and are expected to age; this entry targets only the two present-tense figures that claim to describe the code as it stands.

## Verification

- `node -e 'console.log(require("./models/catalog.json").tuples.length)'` prints the number now written in `docs/ROADMAP.md` goal 4.
- The new test fails when either number in `docs/ROADMAP.md` is edited without a matching code change, and passes on the current tree once both sentences are corrected.

## Triage — 2026-09-07

- **Track:** Q — Verification, shared execution and documentation.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/model-routing/catalog.js:89`, `test/promptobus-package.test.mjs:366`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
