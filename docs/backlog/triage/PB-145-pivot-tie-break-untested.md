# PB-145 · The pivot tie-break rule ADR-005 states — "a tie is settled by (harness, model, effort)" — has no test, because the fixture's only pivot has a unique top run count

- **Scope:** [reference/03-cli](../../reference/03-cli.md) § Model routing (`models calibrate`), [ADR-005](../../adr/adr-005-ten-point-scale-absolute-bands-calibrate.md), `lib/model-routing/calibrate.js`, `test/model-routing-calibrate.test.mjs`
- **Created:** 2026-09-06
- **Dependencies:** none

## Context

`lib/model-routing/calibrate.js:315` — `const pivot = eligible.reduce((best, k) => (best === null || k.runs > best.runs ? k : best), null);` — picks the pivot by run count over `eligible`, an array already sorted by `keyOrder` (harness, then model, then effort; `calibrate.js:163-165`) a few lines above (`calibrate.js:301`, `.sort(keyOrder)`). Because `>` is strict, a tie leaves `best` unchanged and the earlier-ordered key wins — the comment directly above the reduce (`calibrate.js:~311-313`) states this is deliberate: 'ties settled by the key order above... a stable max by run count IS the tie-break — no second rule to keep in step with the first.' ADR-005 states the same contract in prose, at `docs/adr/adr-005-ten-point-scale-absolute-bands-calibrate.md:167`: 'the eligible key with the most runs is the pivot; a tie is settled by (harness, model, effort).' So the implementation matches its own documented intent — this is not a code defect.

What is missing is a test of that branch. Computed the fixture's run counts by key today (`test/fixtures/model-routing/telemetry.jsonl`, `harness`/`model`/`effort` tuples, aliases `opus` and `claude-opus-5` collapsing to one eligible key): opus=8 (4+4 across the alias), sonnet=6, sol=5, gemini=5, haiku=6 (not catalog-rated, so not eligible), fable=2 (below the 5-run threshold, not eligible). The only eligible keys are opus(8), sonnet(6), sol(5), gemini(5) — a unique maximum. No fixture record ever puts two eligible keys at an equal top run count, so the reduce's tie branch (the `best.runs ===` case) never executes under the suite. `test/model-routing-calibrate.test.mjs:183-190` ('the pivot is the most-observed eligible key...') asserts only the untied case.

Confirmed live by mutation: changed `k.runs > best.runs` to `k.runs >= best.runs` in a scratch copy of `calibrate.js` (restored immediately; `git status --short lib/model-routing/calibrate.js` clean afterward) and ran `node --test test/model-routing-calibrate.test.mjs` — 35/35 pass, unchanged. Flipping the direction of the tie-break is completely silent to the suite.

## Work to do

- Add one telemetry record (or reuse an existing eligible model/harness/effort combination) to `test/fixtures/model-routing/telemetry.jsonl` so two eligible keys tie on run count, with the alphabetically-later key (by harness, then model, then effort) NOT otherwise favoured by any other ordering the code might accidentally use.
- Extend `test/model-routing-calibrate.test.mjs` with an assertion that `report().pivot` resolves to the earlier-ordered of the two tied keys — following the file's existing fixture-plus-assertion pattern for its other ADR-005-named cases (threshold, uncatalogued model, dismissed run).
- Re-run the mutation probe (`>` → `>=`) after the new test lands and confirm it now fails, as the record for this change.

## Out of scope

- Any change to `calibrate.js` itself — the reduce already implements ADR-005's rule correctly; this entry closes a test-coverage gap, not a behaviour change.
- Reworking `keyOrder` or the eligibility filter — both are exercised and correct elsewhere in the suite.

## Verification

- `node --test test/model-routing-calibrate.test.mjs` is green with the new fixture record and assertion.
- Mutation probe: change `k.runs > best.runs` to `k.runs >= best.runs` in `lib/model-routing/calibrate.js` — the new test fails; revert and it passes again.
