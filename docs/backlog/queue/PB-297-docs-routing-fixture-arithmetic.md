# PB-297 · Recompute model-routing fixture documentation with the current rating scale

- **Order:** 470
- **Scope:** [03-cli](../../reference/03-cli.md#model-routing); test/fixtures/model-routing/README.md
- **Created:** 2026-09-27
- **Dependencies:** none

- **Cost:** major

## Context

The golden-fixture README explains current checked-in fixture results using the old 1-5 scale and old numeric outputs, so its reproduction instructions are false.

## Evidence

- At b3d4a387, test/fixtures/model-routing/README.md:35 uses `5 * (quotaCost - 1) / 4`; :37 gives balanced=68.05 and balance=65.60; :69 says scale 1-5 and golden scores 69 / 56.25 / 55.25; :62 says the models command test is still pending.

- lib/model-routing/resolver.js:181 uses /9 and both catalog fixtures have schemaVersion 2. decision.json and models.txt contain 71.78 / 56.94 / 54.56 for the golden fixture.

- Read-only mergeRouting + resolve at fixture clock 2026-09-05T09:00:12.000Z returned balanced claude-fable 68.74; balance codex-sol 66.43, effective pace 12.61 and spend penalty 3.89. The audit probe exited 0 for all three fixture scenarios.

- docs/reference/03-cli.md:838 also says quotaCost=5 costs a whole default band. resolver.js:181 gives 2.22 for quotaCost=5 and spendUnit=5; quotaCost=10 gives the full band of 5. The same scale correction belongs in this reference example.

## Work to do

- Update the fixture README to scale 1-10, divisor 9 and the actual frozen-fixture scores, penalties and effective pace.
- Describe the existing models command test as implemented. Preserve fixture bytes and runtime routing policy.
- Correct the shared quotaCost example in docs/reference/03-cli.md:838; verify costs 1/5/10 give penalties 0/2.22/5 with spendUnit=5.

## Out of scope

- Runtime feature changes, publication, and closing unrelated backlog entries.

## Verification

- Run the real resolver with catalog.json/snapshot.json and balance-catalog.json/balance-snapshot.json at the frozen clock; every documented number agrees.
- The fixture README has no current formula using the superseded scale and no claim the existing command is pending.
