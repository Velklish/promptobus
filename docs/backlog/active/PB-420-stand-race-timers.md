# PB-420 · live-codex-stand and live-mixed-stand idle on uncleared race timers after their last check, and the runner names a file that idles after its last verdict

- **Scope:** [Suite isolation](../../guides/contributing.md#suite-isolation)
- **Created:** 2026-11-05
- **Dependencies:** none
- **Cost:** minor
- **Previous order:** 410
- **Taken:** 2026-11-05

## Context

Both stand files bound a child's exit with `Promise.race([child.done, <timer>])` and never clear the timer. The child exits in seconds, the race settles, and the timer keeps the event loop alive until it fires: the file has printed its last verdict and still holds a pool lane or the serial slot.

Evidence: 2026-11-05 on `4acbb783`, eight cores, each file run standalone with a preload that records the last stdout write and the exit moment. `live-codex-stand.test.mjs` — 122.2 s total, 108.4 s after its last check: the 120 000 ms timer of `test/live-codex-stand.test.mjs:92`, plus the 30 000 ms timers of lines 66, 80 and 148. `live-mixed-stand.test.mjs` — 45.1 s total, 9.5 s after its last check: the `sleep(30000)` races of lines 77, 122 and 205; the file is in the serial group, so the whole idle adds to the run. Twenty-five other files measured the same way idle 0–3.1 s. Full `npm test`: 486.4 s wall, 262 files.

Nothing in the run notices a file that idles after its last verdict: the per-file time is printed, but a file that waits on a dead timer looks the same as one that works.

## Work to do

- Clear the race timers in both stand files once the race settles.
- `check.mjs` reports the time between the last verdict and process exit; the runner names, in its end summary, every file that idled at least 5 s after its last verdict. The section does not fail the run.

## Out of scope

- Files written against `node:test`: they do not use `check.mjs`.
- The waits of the serial group's scenarios.

## Verification

- Both stand files standalone: idle after the last check under 2 s, verdict counts unchanged.
- `runner.test.mjs` verdict on the idle section with a fixture file that leaves a timer after its last check, and a mutation probe of the threshold.
- Full `npm test` before and after, by number.
