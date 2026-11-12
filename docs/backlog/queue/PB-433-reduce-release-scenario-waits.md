# PB-433 · Reduce real waits in the measured slow release scenarios

- **Order:** 450
- **Scope:** [Host lifecycle](../../reference/02-host.md), [Suite isolation](../../guides/contributing.md#suite-isolation)
- **Created:** 2026-11-13
- **Dependencies:** none
- **Cost:** major

## Context

The 0.32.9 release audit identified concrete expensive scenarios, including real
heartbeat and abort-cleanup deadlines. Those deadlines test useful behavior;
blindly removing sleeps or shortening production timeouts would lose coverage.

Evidence: on `fe2d59e89e7dbe8061a14432a0d671771cf687d2`, the retained
`recovery-pb-release-gates-fe2d59e8.log` has 276 files: 268 pooled and eight
serial. The serial files took 195.2 s of a 413.1 s runner, including
`promptobus-e2e.test.mjs` (70.0 s) and `live-mixed-stand.test.mjs` (34.8 s).
`live-mixed-timeout-retention.test.mjs` took 78.3 s locally and 68.2 s in
[tag CI](https://github.com/Velklish/promptobus/actions/runs/42846058276).
Its two cases assert `cleanup after SIGTERM did not end in 30000 ms`.
These rounded file timings are historical observations from the 2026-11-13
audit; local and Linux results are not an A/B comparison or a measured speedup.

## Work to do

- Start with the three named files. For each real wait, state the property it
  proves and distinguish state/ordering combinations from actual deadline
  behavior. Measure before choosing a change.
- Move suitable state combinations to controlled clocks or explicit fixture
  barriers. Keep a representative real-process check for the actual heartbeat,
  timeout, abort cleanup and retention guarantees, plus hang watchdogs.
- Prefer the smallest change supported by those measurements. Preserve isolation,
  terminal process accounting, negative controls and cleanup after failure.
- Record paired base/candidate timings on the same runtime, platform, pool and
  workload, for both the changed files and the full runner. Report the remaining
  serial share and observed variation rather than projecting a universal gain.

## Out of scope

- Shortening production deadlines, deleting contract assertions, using real
  model/account quota in CI, or increasing the test pool as the only change.
- A general clock abstraction across the repository or scheduler-ledger caching.
- The separate unconfirmed timing hypotheses PB-419.24 through PB-419.30. Their
  investigation and disposition remain with their existing cards.

## Verification

- A before/after table maps every moved assertion to its replacement and names
  the retained real-time contract. No behavior becomes an unconditional skip.
- After committing, mutation probes prove that a missing heartbeat, premature
  deadline, lost retained artifact and incomplete process cleanup still fail the
  relevant checks. Use only mutations relevant to the actual changed paths.
- Run paired measurements and configured gates on the final candidate. Accept a
  performance change only when measurements demonstrate reduced wall time with
  the same guarantees; report inconclusive results without claiming an improvement.
- Document the changed test strategy and its limits in the contributing guide.
