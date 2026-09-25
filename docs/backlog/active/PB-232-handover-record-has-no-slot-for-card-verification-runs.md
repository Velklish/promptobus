# PB-232 · The handover record has no slot for a card's own verification runs, so they land in the gate record under a tail

- **Scope:** `schemas/v1/handover-record.schema.json`, `schemas/v1/gate-record.schema.json`, [03-cli](../../reference/03-cli.md) § the hand-off form
- **Created:** 2026-09-17, consumer run
- **Dependencies:** PB-234.2 — either home is a new field in a published record schema
- **Cost:** major
- **Previous order:** 180
- **Taken:** 2026-09-25

## Context

A card can name its own verification beside the project gates — «`node test/promptobus-mixed.test.mjs` green twice in a row» was the verification line of the card that split step 7 of the scenario. The worker who closed it was asked to put both runs into the handover record next to the five checks and could not: the schema has `additionalProperties: false` at the root and under `checks`, and `checks` is a fixed set of five names (`verdictNames`, `mutationProbe`, `treeState`, `environmentalRed`, `gatesNotRun`). Measured on 2026-09-17 by reading the schema in the tree at `88a336ef`.

The runs went into the gate record instead, as two extra entries whose `tail` says «CARD VERIFICATION RUN, not a project gate», and the aggregate line stayed «gates 4». That works, and the approver repeated the same form on the merged tree, but it is a form break, not a choice: a reader of the gate record has to know that two of its entries are not gates, and nothing in the schema marks them.

## Work to do

- **The owner's decision, 2026-09-25:** the home is a typed marker on gate-record entries, `kind: gate | verification`; the aggregate ("gates N, green M") counts `gate` entries only. The handover record keeps its five checks; a sixth check is not taken.
- Decide where a card's own verification belongs: a sixth optional check in the handover record (`cardVerification`: command, runs with exit codes, what the card asked), or a typed marker on a gate-record entry (`kind: gate | verification`) so an aggregate can be recomputed from the record. One place, not both.
- Whichever home is chosen, the reviewer's subject and the approver's brief in the consumer should be able to point at it by name.

## Out of scope

- Re-shaping the five existing checks: they stay as they are.

## Verification

- A record carrying one card verification run validates on send under the chosen home; the same run placed anywhere else is refused by field name.

## Re-triage, 2026-09-23

Checked on `39316bc2` from the repository root. **Cost `major`**: a card's own verification runs sit unmarked in the gate record. A reader must know which entries are not gates, the aggregate cannot be recomputed from the record, and the reviewer compares that record with the tree.

- The schema is as measured: `node -e` over `schemas/v1/handover-record.schema.json` → exit 0, `additionalProperties` false at the root and under `checks`, and `checks` has exactly `verdictNames`, `mutationProbe`, `treeState`, `environmentalRed` and `gatesNotRun` (also `HANDOVER_CHECKS`, `lib/handoff.js:29`). `88a336ef` has the same five.
- The gate record has no `kind`: `grep -n kind schemas/v1/gate-record.schema.json` → exit 1. Its entry is closed on `command`, `exit`, `counts`, `tree`, `dirty`, `at`, `by` and `tail`.
- The verification line quoted in the Context is PB-159.3's: [docs/archive/LOG.md#pb-159.3](../../archive/LOG.md#pb-159.3), `task.md:116`, and its `result.md:9` and `:17` name this gap.
- No slot has been added since: `git log --oneline 242158d7..HEAD -- schemas/v1/` → exit 0, `29504ce4` (PB-234, `mutationProbe.expected`) only.
- Either home is a new field in a published record schema, so PB-234.2's release seam applies; it is now a dependency.
