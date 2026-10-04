# PB-340 · Own reusable live harness scenarios and consumer integration probes

- **Scope:** [Drivers](../../reference/05-drivers.md)
- **Created:** 2026-10-04
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 20
- **Taken:** 2026-10-04

## Context

At `6f4e9a3`, Promptobus owns `scripts/live-codex.mjs`, `scripts/live-cursor.mjs` and `scripts/live-mixed.mjs`, but a consumer also maintains copies of these product scenarios that import private drivers. The owner has selected consolidation of these three scenarios in Promptobus; consumer-host end-to-end and canary assembly stays with that consumer.

The paired audit identified task-identity and abort-cleanup differences worth comparing before removing copies. Locally, `scripts/live-e2e.mjs:32,173` imports and calls runScenario; `test/scenario.mjs:464-470` accepts neither a caller task id nor an abort callback and fixes TASK to one literal. This is source evidence, not a reproduced live failure or proof that every caller needs a new option.

## Work to do

- Make the Codex, Cursor and mixed-harness product scenarios canonical package checks using the standalone/default host.
- Inventory differences in the consumer copies and preserve useful fixes, including relevant task-identity and abort/cleanup behavior, before removing duplicate implementations.
- Keep product scenarios neutral. Consumer-host end-to-end and canary assembly stays in the consumer project; consolidation does not require a shared scenario library.
- Update package validation instructions and coordinate removal of the duplicate participant scenarios and their calls from the consumer.

## Out of scope

- Moving consumer organization setup, deployment policy or credentials into Promptobus.
- Assuming every caller-specific change belongs upstream or exposing every test helper.
- Claiming a live failure or successful paid harness run from source comparison alone.

## Verification

- Neutral fixture callers verify task identity consistency and cancellation/cleanup at the agreed boundaries; cleanup touches only resources owned by the run.
- All three canonical package scenarios retain their coverage. The paired consumer keeps host-specific checks and no longer maintains copies of these product scenarios.
- Record how each useful borrowed fix was retained or why it remains consumer-owned.
- Run applicable automated checks. Report any separately approved live measurement with versions, commands, exits and cleanup evidence; name unmeasured paths explicitly.
