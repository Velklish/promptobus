# PB-421 · The runner keeps a per-file time ledger, hands files to the pool longest first, takes the pool width from PROMPTOBUS_TEST_POOL and names files that became twice as slow

- **Scope:** [Suite isolation](../../guides/contributing.md#suite-isolation)
- **Created:** 2026-11-05
- **Dependencies:** PB-420
- **Cost:** minor
- **Previous order:** 420
- **Taken:** 2026-11-05

## Context

`test/run.mjs` hands pool files to lanes in name order and keeps no record of file durations. A long file with a late name starts late and stretches the tail of the pool, and a file that grows from 14 s to 122 s goes unnoticed: nothing compares a run with the previous ones. The pool width is the constant `min(6, cores − 2)`, so another width cannot be measured without editing the runner.

Evidence: 2026-11-05 on `4acbb783`, eight cores, full `npm test` 486.4 s wall (user 647.5 s, sys 290.5 s), 253 pool files with 1415 s of file time, the serial group 232.6 s. A model of the pool from that run's file times gives 252 s in name order — the measured pool took about 253 s — and 236 s longest first, which is the lower bound for six lanes; with the PB-420 timer removed, 232 s and 218 s. The model gives 163–187 s for seven and eight lanes, but it does not include the slowdown each file suffers under a wider pool.

## Work to do

- A ledger: one JSON line per file per run with its outcome and duration, and the run's wall time; default path under `node_modules/.cache`, overridden by an environment variable.
- Hand-out to the pool by descending median duration over the ledger's recent runs; a file without history first; ties by name. Without a ledger — name order.
- `PROMPTOBUS_TEST_POOL` sets the pool width; an invalid value refuses before any file starts.
- The end summary names files that took at least twice their median and at least 5 s more; the section does not fail the run.
- Measure full runs at widths 6, 7 and 8; the default changes only if the measurement supports it.

## Out of scope

- Membership of the serial group.
- Retrying or quarantining files.

## Verification

- `runner.test.mjs` verdicts on the ledger lines, the hand-out order from a seeded ledger, the width from the variable, the refusal of an invalid width and the slow-file section, each with a mutation probe.
- Full `npm test` before and after, by number.
