# PB-401 · Confirm native Stop termination and retain final command accounting

- **Scope:** [Codex holder shutdown](../../reference/05-drivers.md#codex-holder-shutdown)
- **Created:** 2026-10-23
- **Dependencies:** none
- **Cost:** major
- **Taken:** 2026-10-26

## Context

The native observer experiment on 2026-10-23 measured a successful Stop response before the owned command's last heartbeat and exit callback. The original polling tool call was aborted without a final command-exit result. In `lib/codex-session.js`, holder shutdown waits for interrupt acknowledgements with `Promise.allSettled`, kills app-server, and returns success. In `lib/driver-codex.js`, holder disappearance permits dropping the session and its participant home. The holder shutdown fixture currently treats interrupt refusal and timeout as successful shutdown.

## Work to do

- Reproduce false success deterministically before changing production code.
- Latch stopping and close new model dispatch, account for in-flight turn requests, terminal turns and command lifecycle/output evidence under one deadline.
- Preserve factual command outcomes and selected lifecycle evidence outside the participant home; distinguish them from original upstream tool receipts.
- Return explicit unresolved/nonpassing outcomes and retain recoverable state when termination, final streams or durable persistence cannot be confirmed.
- Cover active, idle, repeated and failed Stop paths; update native contract documentation and CHANGELOG; commit and mutation-probe the regression.

## Out of scope

- Permission widening, unrelated process signals, broad PID cleanup, provider bridges, generalized lifecycle services and production distribution.
- Reclassifying prior failed native experiments or acceptance ledgers; source-only suites as real native proof.

## Verification

- Run `node test/codex-holder-shutdown.test.mjs` with a regression that rejects success for interrupt refusal/hang; preserve red results on unchanged production source.
- Exercise acknowledgement-before-terminal/trailing-output, active background command, unknown terminal outcome, persistence/stream refusal and in-flight request races with deterministic owned fixtures.
- Run committed mutation probes, focused tests, `npx --no-install backslop gates --require-clean --base 875428d72d8d63d1e0d103418f56c1a940ff523a`, independent review and then a separately identified restricted native active-command case.
- Keep Stop operation outcome, command exit/test outcome, final receipt completeness, physical cleanup and canonical task state separate in evidence.

## Source identity

This task continues the native Stop candidate formerly identified as PB-397 at a19212d734b85219cd2d0242147ff17c9af76037. It is now PB-401 to preserve the unrelated visual-dashboard PB-397 already on main. PB-396 remains the separate standard-workspace task. Candidate child findings are not silently accepted by this transfer.
