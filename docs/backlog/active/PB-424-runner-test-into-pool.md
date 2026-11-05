# PB-424 · runner.test.mjs leaves the serial group, and the runner's register names why each remaining serial file needs a still machine

- **Scope:** [Suite isolation](../../guides/contributing.md#suite-isolation)
- **Created:** 2026-11-05
- **Dependencies:** none
- **Cost:** minor
- **Previous order:** 60
- **Taken:** 2026-11-05

## Context

The serial group runs its files one by one after the pool, so each second of it is a second of `npm test`; it took 190.7 s of a 369.5 s run. The header of `test/run.mjs` says `runner.test.mjs` is there only because its nested runner copies open lanes of their own and take time from neighbours, "not because the verdict needs a still machine": its concurrency verdict reads the peak of live children, not a clock. Two later members have no stated reason at all: `live-mixed-stand.test.mjs` and `shared-service-standalone-root.test.mjs` entered the list without a line in the register, in the commit or in the task body.

Evidence: 2026-11-05 on `15d6f1e9`. `runner.test.mjs` took 17.6–18.3 s in the serial group across five full runs; its nested fixtures are trivial files, and its timing-sensitive probes already swap their thresholds (file timeout, watchdog, idle, slow file) with slack for parallel runs. `live-mixed-stand.test.mjs` asserts a wall-clock budget — "the run ends inside the awaited-cleanup bound", `hangElapsed < 10_000` against a 5 s stop budget with a 5 s allowance; `shared-service-standalone-root.test.mjs` holds cross-process barriers of 1000 ms in its native fixtures. Both stay serial.

## Work to do

- Move `runner.test.mjs` into the pool.
- Name the reason for every remaining serial file in the register of `test/run.mjs`.

## Out of scope

- Moving any file whose verdict depends on wall-clock time.

## Verification

- `runner.test.mjs` passes inside full runs under the pool, and the serial group shrinks by its time.
