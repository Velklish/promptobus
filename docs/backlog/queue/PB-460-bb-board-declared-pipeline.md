# PB-460 · Show a host-declared pipeline on the BB board

- **Order:** 820
- **Scope:** [BB native panel](../../../integrations/bb-native-observer/README.md#board)
- **Created:** 2026-11-19
- **Dependencies:** none
- **Cost:** major

## Context

The board of PB-459 builds its columns from the shipped pipeline worker → reviewer → approver and appends a step it does not know in address order (`integrations/bb-native-observer/board.ts`, `boardSteps`). A pipeline a host declared in `promptobus.json` lives with the host, and the observer reads only the store and the native root. A declared pipeline that drops a shipped step therefore shows its pieces waiting at a step that does not exist; one that reorders steps shows them in the wrong column. `promptobus digest` places the same pieces correctly, because it reads the host. Since PB-459 the lane says when its order is inferred. Found in the PB-459 review.

## Work to do

- Make the run's pipeline visible to a reader of the store: either the engine records the step order in the task when the run starts, or the panel reads the host configuration on an explicit setting.
- The board uses that order and drops the "inferred" note when it is known.
- A run without a recorded order keeps the current inference.

## Out of scope

- Editing the pipeline from the panel.

## Verification

- A run whose pipeline drops `reviewer` puts a piece after `worker` straight into `approver`, as `promptobus digest` does for the same store.
- A run with reordered steps shows the declared order.
