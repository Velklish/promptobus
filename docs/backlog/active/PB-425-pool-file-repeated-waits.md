# PB-425 · codex-schema-gate recompiles the same Codex schemas on every gate call, and promptobus-driver-codex waits a full 10 s Stop budget on a cleanup that never confirms

- **Scope:** [Suite isolation](../../guides/contributing.md#suite-isolation)
- **Created:** 2026-11-05
- **Dependencies:** none
- **Cost:** minor
- **Previous order:** 70
- **Taken:** 2026-11-05

## Context

The pool runs at its lower bound, the summed file time over the width, so every six seconds of file work cut is about one second of `npm test`. Two of the longest pool files spend most of that work on repetition.

Evidence: 2026-11-05 on `15d6f1e9`, official Node 26.13.0, eight cores. `codex-schema-gate.test.mjs` took 43–113 s in full runs and 49 s standalone; each `gate()` call runs `checkCodexSchema`, whose `validateConsumedContract` creates a new Ajv and compiles every consumed schema of the minimum and the committed capture again — measured 1192 ms and 499 ms cold, 221–347 ms warm per capture, and the file calls the gate dozens of times. `promptobus-driver-codex.test.mjs` took 62–75 s; 10 005 ms of it is the cleanup `codexDriver.stop` of the participant whose first turn never ends, and that stop returned `ok: false`, "the holder did not reply in 10000 ms", every time — no verdict reads it.

## Work to do

- Reuse compiled schema validators across calls in one process, keyed by schema content and its definitions.
- Give the never-confirming cleanup stop a short budget.

## Out of scope

- The 30 s abort wait of `live-mixed-timeout-retention.test.mjs`: its verdict asserts that unchanged wait.

## Verification

- `codex-schema-gate.test.mjs` and `npm run codex-schema` green, with the file time before and after.
- `promptobus-driver-codex.test.mjs` green, with the file time before and after.
