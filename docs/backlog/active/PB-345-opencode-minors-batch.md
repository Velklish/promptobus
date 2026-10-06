# PB-345 · Opencode minors batch: guard-hook probe and send-refused proof

- **Scope:** [05-drivers](../../reference/05-drivers.md)
- **Created:** 2026-10-06
- **Dependencies:** PB-344 (handover makes both provable live)
- **Cost:** major
- **Taken:** 2026-10-06
- **Batch:** PB-343.1, PB-343.2

## Context

Two minor entries on the opencode driver. PB-343.2 (send-refused hypothesis): PB-344 fixed the cause and saw clean delivery live, but the fixture still carries the fallback transcript. PB-343.1 (guard-hook): no loop guard on the holder; the docs already say so and dry-run no longer names ghost files. OpenCode plugins expose a `session.idle` event, which may carry a guard equivalent.

## Work to do

- PB-343.2: one live teamlead lift, capture clean status+result delivery into the fixture, update the test and the docs, close the hypothesis as fixed.
- PB-343.1: probe whether a `session.idle` plugin hook can run the guard and continue the turn. If yes, ship the plugin in the holder dir with tests and docs. If the turn cannot be continued, document the boundary and move the entry to deferred with a return condition.

## Out of scope

- Managed-root `lead`, other harnesses, wake-in to the orchestrator session.

## Verification

- `npx --no-install backslop gates` green; `npm run probe` on new checks (commit first).
- Live lifts on a scratch root for both entries.
