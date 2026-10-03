# PB-325 · Three test files go red under machine load: lead-lifecycle, promptobus-e2e and codex-holder-spawn

- **Scope:** [Contributing § Suite isolation](../../guides/contributing.md#suite-isolation)
- **Created:** 2026-10-04
- **Dependencies:** none
- **Cost:** major

## Context

In run bs020 on 2026-10-03 the machine load was 36–97 on 8 cores: several gates ran at once beside live participants. Three files went red in full gates and passed when run alone:

- `test/lead-lifecycle.test.mjs`: the fixture aborted with "task … is not in …/tasks", three times (worker:pb311 on `8ab494c2`, twice worker:pb317). Alone: 9/9 twice on the branch and twice on the base.
- `test/promptobus-e2e.test.mjs`: the re-knock verdicts, 54/57. Alone: red twice on the base `e639d8cf`, green twice on the branch `10df0fb`, so the red is not tied to that change.
- `test/codex-holder-spawn.test.mjs`: a timeout at 2379 ms in approver:pb311's full run. Alone: 2/2 green on the head and on the base.

Each red cost a fresh full gate of about five to six minutes plus four standalone runs as evidence. PB-320 covers `model-routing-preflight` separately.

## Work to do

- For each file find what depends on timing or ordering. Suite isolation names the commonest cause: a single read of a file another process writes.
- Start with `promptobus-e2e`, which is red on the base.

## Out of scope

- `model-routing-preflight`, which is PB-320.

## Verification

- Each file passes ten runs in a row while a full `npm test` runs beside it.
