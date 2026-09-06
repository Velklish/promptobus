# PB-82 · The packaging test checks that templates and the four v1 schemas ship in the tarball but never checks `models/catalog.json`, the file the model catalog module assumes is there

- **Order:** 550
- **Scope:** `test/promptobus-package.test.mjs`, `lib/model-routing/catalog.js`, `package.json`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`package.json:11` lists `"models"` in `"files"`, and `lib/model-routing/catalog.js:34` builds `CATALOG_FILE` on that assumption, stated as a fact in the comment directly above it: `/** Shipped catalog. \`models/\` is in \`files\`, so this path exists in the tarball too. */`. `test/promptobus-package.test.mjs` runs `npm pack --dry-run --json` and asserts on the resulting file list (`packed.files`, lines 340-358): it checks `package.json`, the built `dist/*.js`/`*.d.ts` files, `templates/bus-hook.mjs`, and the four `schemas/v1/*.schema.json` files (built from `SCHEMAS_V1` at line 353) — `grep -n "models\|catalog" test/promptobus-package.test.mjs` returns no match, so nothing in this file asserts that `models/catalog.json` is actually in the packed tarball.

`git log -S SCHEMAS_V1 -- test/promptobus-package.test.mjs` shows this packaging-check block predates the model-routing feature that introduced `models/catalog.json` and `CATALOG_FILE` — the file and its packaging assumption were added later without the packaging test being extended to cover them, which reads as an oversight rather than a deliberate exclusion: nothing in this test file or in `docs/reference/` argues for leaving the catalog file unchecked. If `"models"` were ever dropped from `package.json`'s `files` array (a one-line typo or a merge conflict resolved wrong), every routed pick in the installed package would break at the first call to `resolve()` while this packaging suite stayed green.

## Work to do

- Add one assertion beside the existing `SCHEMAS_V1` check in `test/promptobus-package.test.mjs`, after `packed.files` is computed: `check('tarball contains the model catalog', packed.ok && files.includes('models/catalog.json'), files.filter((f) => f.startsWith('models/')).join(', ') || files.join(', '));`, mirroring the existing style of the bus-hook and schema checks.

## Out of scope

- Checking every file under `models/` or `schemas/model-routing/` individually — the catalog file is the one this module hard-codes a path to and depends on at runtime; broader packaging coverage is a separate concern from this specific load-bearing gap.

## Verification

- `npm test` passes with the new check green.
- Temporarily remove `"models"` from `package.json`'s `files` array and re-run `npm test`: the new check fails with a clear message; restore the array afterward.

## Triage — 2026-09-07

- **Track:** Q — Verification, shared execution and documentation.
- **Priority:** P2.
- **Evidence level:** source/definition review at `1e0401a`, including `lib/model-routing/catalog.js:34`. Historical live measurements were not repeated; a regression reproducer is still required before a runtime fix is accepted.
- **Next step:** Keep the stated subject and acceptance cases. Implement the smallest repair; optional redesigns and unrelated cleanup are excluded.
