# PB-232 · The handover record has no slot for a card's own verification runs, so they land in the gate record under a tail

- **Order:** 
- **Scope:** `schemas/v1/handover-record.schema.json`, `schemas/v1/gate-record.schema.json`, [03-cli](../../reference/03-cli.md) § the hand-off form
- **Created:** 2026-09-17, consumer run
- **Dependencies:** none

## Context

A card can name its own verification beside the project gates — «`node test/promptobus-mixed.test.mjs` green twice in a row» was the verification line of the card that split step 7 of the scenario. The worker who closed it was asked to put both runs into the handover record next to the five checks and could not: the schema has `additionalProperties: false` at the root and under `checks`, and `checks` is a fixed set of five names (`verdictNames`, `mutationProbe`, `treeState`, `environmentalRed`, `gatesNotRun`). Measured on 2026-09-17 by reading the schema in the tree at `88a336ef`.

The runs went into the gate record instead, as two extra entries whose `tail` says «CARD VERIFICATION RUN, not a project gate», and the aggregate line stayed «gates 4». That works, and the approver repeated the same form on the merged tree, but it is a form break, not a choice: a reader of the gate record has to know that two of its entries are not gates, and nothing in the schema marks them.

## Work to do

- Decide where a card's own verification belongs: a sixth optional check in the handover record (`cardVerification`: command, runs with exit codes, what the card asked), or a typed marker on a gate-record entry (`kind: gate | verification`) so an aggregate can be recomputed from the record. One place, not both.
- Whichever home is chosen, the reviewer's subject and the approver's brief in the consumer should be able to point at it by name.

## Out of scope

- Re-shaping the five existing checks: they stay as they are.

## Verification

- A record carrying one card verification run validates on send under the chosen home; the same run placed anywhere else is refused by field name.
