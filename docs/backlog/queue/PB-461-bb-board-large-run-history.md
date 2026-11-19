# PB-461 · Read the BB board of a run past 4096 history references

- **Order:** 830
- **Scope:** [BB native panel](../../../integrations/bb-native-observer/README.md#board)
- **Created:** 2026-11-19
- **Dependencies:** none
- **Cost:** minor

## Context

The board reads a whole run through `taskMessages` (`integrations/bb-native-observer/projection.ts`), which enumerates at most 4096 inbox and history references and refuses past that. A long run with many pieces exceeds it: its lane shows the error instead of its pieces, and its piece history is unavailable. Each 2-second poll also reads every referenced message of up to 16 runs within the per-record size limit, with no budget for the run as a whole. Found in the PB-459 review; the bounded reader predates the board.

## Work to do

- Read a lane from the newest references within a fixed budget, and say on the lane that older ones were not read, instead of refusing the run.
- Bound the bytes one board sample reads across all runs.

## Out of scope

- Caching samples between polls.

## Verification

- A fixture run with more than 4096 references shows its pieces and a note about the unread older messages.
- A sample over the byte budget stops reading and says so, and the other lanes stay visible.
