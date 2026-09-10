# PB-159 · `model-routing-preflight.test.mjs` goes red in the pooled `npm test` under machine load while every standalone run is green, so a full-suite gate fails for reasons unrelated to the change under test

- **Scope:** `test/model-routing-preflight.test.mjs`, `test/run.mjs` (the pool and serial groups), [guides/contributing](../../guides/contributing.md) § gates
- **Created:** 2026-09-10
- **Dependencies:** none

## Context

Observed twice during the 2026-09-09 backlog run, both times with four to six worker sessions running full suites in parallel on one machine:

- 2026-09-09 ~23:58 UTC, load average ≈ 14: the `worker:launch` baseline `npm test` on an untouched tree reported 53/54 files, `model-routing-preflight.test.mjs` exit 1; the same file standalone, `node --test test/model-routing-preflight.test.mjs`, exit 0 with 35/35 twice in a row.
- 2026-09-10 01:41 UTC, load average ≈ 6: the `worker:docs` gate for PB-46 (a documentation-only change plus one catalog test) reported 53/54 files, the same file exit 1; standalone exit 0, 35/35 twice; the orchestrator measured the file on `main` at `0336692` standalone exit 0 twice.

The file carries the only wall-clock assertions in the suite that depend on the machine's neighbours: `assert.ok(elapsed < budgetMs * 25, …)` in "a slow adapter does not hold the preflight" (a 200 ms budget, so five seconds under a pool of 49 files), and in "a probe in flight does not stop the budget timer beside it" both `took > 250` and `ticks >= 5` for a 20 ms interval beside a 400 ms stub. The comments already state that a millisecond threshold "measures the machine's neighbours"; the twenty-five-fold margin was chosen for the pool at ordinary load, not for a machine running several suites at once. The exact failing assertion text was not captured in either pooled run: the runner reports the file's exit code, and the file's own output is not kept.

## Work to do

- Capture the failing assertion: make the runner keep the last lines of a red file's output in its summary, so the next pooled red names the assertion instead of the exit code.
- Then either move the file to the serial group the runner already has (five files run there today), or replace the two wall-clock checks with counted evidence the way the second case's comment describes for `ticks`, so that the assertion no longer depends on neighbours.
- Say in `docs/guides/contributing.md` § gates which files run serially and why.

## Out of scope

- The preflight budget itself and the adapters' timeouts — the mechanism is not in question, only the test's dependence on wall-clock under load.
- A general retry-on-red policy in the runner: a retried gate hides a real regression.

## Verification

- With the machine under load (for example two full `npm test` runs started in parallel), the pooled suite stays 54/54 across three consecutive runs.
- A pooled red of any file prints its failing assertion in the runner summary (probe: make one assertion fail on purpose, read the summary, restore).
- `npm test` green.
